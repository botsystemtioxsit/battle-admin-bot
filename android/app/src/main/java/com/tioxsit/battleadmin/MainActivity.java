package com.tioxsit.battleadmin;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private static final String ADMIN_URL =
            "https://botsystemtioxsit.github.io/battle-admin-bot/public/admin.html";

    // Тот же фиксированный тег релиза android-latest, что публикует
    // .github/workflows/build-android-apk.yml — оба файла всегда лежат
    // рядом под одним и тем же стабильным URL, обновляясь при каждой сборке.
    private static final String RELEASE_BASE =
            "https://github.com/botsystemtioxsit/battle-admin-bot/releases/download/android-latest/";
    private static final String VERSION_JSON_URL = RELEASE_BASE + "version.json";
    private static final String APK_URL = RELEASE_BASE + "app-debug.apk";

    private WebView webView;
    private long updateDownloadId = -1;
    private boolean awaitingInstallPermission = false;
    private BroadcastReceiver downloadReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setUseWideViewPort(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.getHost() != null && uri.getHost().endsWith("botsystemtioxsit.github.io")) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });

        // admin.html gates most actions behind window.confirm()/alert()/prompt()
        // (toggles, bans, resets — ~50 call sites). Plain WebView has no default
        // UI for these: without a WebChromeClient overriding onJsAlert/onJsConfirm/
        // onJsPrompt, the JS call just resolves immediately with no dialog shown
        // at all (confirm() -> false), so every "if (!confirm(...)) return;" guard
        // silently no-ops. That's what looked like "buttons do nothing" — the
        // click handlers were running, just bailing out on the invisible dialog.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .setCancelable(true)
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setInputType(InputType.TYPE_CLASS_TEXT);
                if (defaultValue != null) input.setText(defaultValue);
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener((DialogInterface.OnCancelListener) dialog -> result.cancel())
                        .setCancelable(true)
                        .show();
                return true;
            }
        });

        // Lets a Play Store "Android System WebView" build be inspected via
        // chrome://inspect over USB — needed to diagnose anything like this
        // bug directly instead of guessing from a description of the symptom.
        // Debug-build only (this APK is only ever built as debug, see
        // android/README.md), so it never ships to a release build.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        setContentView(webView);
        webView.loadUrl(ADMIN_URL);

        registerDownloadReceiver();
        checkForUpdate();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Пользователь мог только что вернуться из системных настроек, где
        // разрешал "Установка неизвестных приложений" для этого пакета (см.
        // startUpdateFlow ниже) — если так, докручиваем обновление, вместо
        // того чтобы заставлять его снова находить и жать "Обновить".
        if (awaitingInstallPermission && canInstallPackages()) {
            awaitingInstallPermission = false;
            enqueueApkDownload();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (downloadReceiver != null) {
            try {
                unregisterReceiver(downloadReceiver);
            } catch (IllegalArgumentException ignored) {
                // уже отвязан — например, если onDestroy вызван до того, как
                // onCreate успел зарегистрировать ресивер
            }
        }
    }

    // ===== Автообновление =====
    // Тот же принцип, что у Telegram и у desktop-сборки этой же панели
    // (electron-updater, см. ../desktop): при старте молча сверяем свою
    // версию с той, что реально задеплоена (version.json из последнего
    // релиза android-latest), и только если она новее — показываем диалог.
    // Ничего не показываем при сетевой ошибке или отсутствии обновления —
    // это фоновая проверка, а не то, ради чего человек открыл панель.

    private void checkForUpdate() {
        new Thread(() -> {
            try {
                int localVersionCode = getPackageManager()
                        .getPackageInfo(getPackageName(), 0).versionCode;

                HttpURLConnection conn = (HttpURLConnection) new URL(VERSION_JSON_URL).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                StringBuilder sb = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                } finally {
                    conn.disconnect();
                }

                JSONObject json = new JSONObject(sb.toString());
                int remoteVersionCode = json.getInt("versionCode");
                String remoteVersionName = json.optString("versionName", "?");

                if (remoteVersionCode > localVersionCode) {
                    runOnUiThread(() -> showUpdateDialog(remoteVersionName));
                }
            } catch (Exception e) {
                // Нет сети / GitHub недоступен / битый JSON — не критично,
                // просто пропускаем проверку до следующего запуска панели.
                Log.w("BattleAdmin", "Проверка обновлений не удалась", e);
            }
        }).start();
    }

    private void showUpdateDialog(String remoteVersionName) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление")
                .setMessage("Вышла версия " + remoteVersionName + ". Скачать и установить сейчас?")
                .setPositiveButton("Обновить", (dialog, which) -> startUpdateFlow())
                .setNegativeButton("Позже", null)
                .setCancelable(true)
                .show();
    }

    private boolean canInstallPackages() {
        // canRequestPackageInstalls появился только в API 26 — до него
        // источник "неизвестных приложений" был одним общим тумблером в
        // системных настройках, а не разрешением на конкретный пакет, и
        // проверить его программно нельзя было в принципе, поэтому ниже
        // просто пробуем ставить и ловим ошибку, если что-то не так.
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getPackageManager().canRequestPackageInstalls();
    }

    private void startUpdateFlow() {
        if (!canInstallPackages()) {
            awaitingInstallPermission = true;
            Toast.makeText(this, "Разреши установку из этого приложения и вернись назад", Toast.LENGTH_LONG).show();
            Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            try {
                startActivity(intent);
            } catch (Exception e) {
                awaitingInstallPermission = false;
                Toast.makeText(this, "Не удалось открыть настройки установки", Toast.LENGTH_SHORT).show();
            }
            return;
        }
        enqueueApkDownload();
    }

    private static final String UPDATE_APK_FILENAME = "battle-admin-update.apk";

    private void enqueueApkDownload() {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        // Одноимённый файл от прошлого обновления мог остаться на диске —
        // DownloadManager на новый enqueue() в тот же путь у части версий
        // Android бросает исключение вместо того, чтобы просто перезаписать.
        java.io.File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
        if (dir != null) {
            java.io.File existing = new java.io.File(dir, UPDATE_APK_FILENAME);
            if (existing.exists()) existing.delete();
        }
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(APK_URL))
                .setTitle("БАТТЛ Админ — обновление")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, UPDATE_APK_FILENAME)
                .setMimeType("application/vnd.android.package-archive");
        updateDownloadId = dm.enqueue(request);
        Toast.makeText(this, "Скачивается обновление…", Toast.LENGTH_SHORT).show();
    }

    private void registerDownloadReceiver() {
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long finishedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (finishedId == -1 || finishedId != updateDownloadId) return;
                promptInstall(finishedId);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }
    }

    private void promptInstall(long downloadId) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        // DownloadManager сам отдаёт content:// URI на скачанный файл — не
        // нужен собственный FileProvider/зависимость androidx.core: начиная
        // с API 24 (наш minSdk) голый file:// URI в install-интенте всё
        // равно бросил бы FileUriExposedException.
        Uri apkUri = dm.getUriForDownloadedFile(downloadId);
        if (apkUri == null) {
            Toast.makeText(this, "Файл обновления не найден после скачивания", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent installIntent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apkUri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(installIntent);
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось запустить установку: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
