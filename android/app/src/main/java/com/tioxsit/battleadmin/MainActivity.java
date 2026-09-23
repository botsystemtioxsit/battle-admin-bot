package com.tioxsit.battleadmin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
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

    // ===== Проверка обновлений =====
    // Тот же принцип, что у Telegram и у desktop-сборки этой же панели
    // (electron-updater, см. ../desktop): при старте молча сверяем свою
    // версию с той, что реально задеплоена (version.json из последнего
    // релиза android-latest), и только если она новее — показываем диалог.
    // Ничего не показываем при сетевой ошибке или отсутствии обновления —
    // это фоновая проверка, а не то, ради чего человек открыл панель.
    //
    // Раньше по кнопке "Обновить" приложение само скачивало APK через
    // DownloadManager и сразу открывало системный установщик — для этого
    // требовалось разрешение REQUEST_INSTALL_PACKAGES. Google Play Защита
    // распознала именно эту связку (сторонний неизвестный APK, который сам
    // умеет ставить другие APK) как поведение трояна-дроппера и стала
    // блокировать установку самого приложения целиком — то есть "починка"
    // сделала APK менее устанавливаемым, а не более удобным. Поэтому теперь
    // по кнопке просто открывается ссылка на APK в браузере — установку
    // человек, как и раньше при самой первой установке, довершает сам
    // тапом по скачанному файлу. Разрешение REQUEST_INSTALL_PACKAGES само
    // приложение больше не запрашивает и не использует.

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
                .setMessage("Вышла версия " + remoteVersionName + ". Открыть страницу скачивания?")
                .setPositiveButton("Обновить", (dialog, which) ->
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(APK_URL))))
                .setNegativeButton("Позже", null)
                .setCancelable(true)
                .show();
    }
}
