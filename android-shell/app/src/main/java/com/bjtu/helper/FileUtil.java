package com.bjtu.helper;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 为 WebView 的"拍照"生成一个可写的临时图片 Uri。
 * 纯框架实现：API<29 用 FileProvider 无法内联，这里改用媒体库临时文件；
 * 若你已配置 FileProvider，可自行替换为 getUriForFile。
 */
final class FileUtil {

    private FileUtil() {}

    /** 生成用于相机输出的图片 Uri（写入公共媒体，便于后续 onActivityResult 读取） */
    static Uri createImageUri(Context ctx) {
        String name = "bjtu_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".jpg";
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        if (Build.VERSION.SDK_INT >= 29) {
            cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/bjtu-helper");
        } else {
            // API 24-28：写到外部私有目录再暴露
            File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_PICTURES), "bjtu-helper");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream fos = new FileOutputStream(f)) { /* 占位 */ }
            catch (IOException e) { return null; }
            return Uri.fromFile(f);
        }
        try {
            return ctx.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 把一个字节数组写成「下载」目录里的文件，返回给用户看的说明。
     *
     * ## 为什么需要它
     *
     * WebView 里 `<a download>` 点了**完全没反应** —— WebView 没有下载管理器，
     * 点击事件被它自己吞掉。所以网页侧的课件 / 成绩单 / 邮件附件 / .ics 导出
     * 在 App 里全部失效（2026-10-18 用户报的「课件下载与成绩单下载有问题」）。
     *
     * ## 两套 API 的分界
     *
     * - **API ≥ 29（Android 10+）**：走 MediaStore。RELATIVE_PATH 指到
     *   `Downloads/bjtu-helper`，写入后系统下载器会看到这个文件，
     *   通知栏一般会提示「已下载」。**不需要任何存储权限**（分区存储）。
     * - **API < 29**：MediaStore 的 Downloads 集合写入受限，改用应用外部私有目录
     *   `Android/data/<pkg>/files/Downloads`，再用 FileProvider 授一个读权限的
     *   ACTION_VIEW，让系统「下载」或文件管理器能打开它。
     *
     * ## 返回约定
     *
     * 返回空串表示成功，其它为**给用户看的中文错误说明**。
     * 与 BjtuCalendar.addEvent 的约定一致：桥不抛异常，失败也是返回值。
     */
    static String saveBytes(Context ctx, String fileName, String mime, byte[] bytes) {
        if (bytes == null) return "文件内容为空";
        String safeName = sanitize(fileName);
        String safeMime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;

        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
            cv.put(MediaStore.Downloads.MIME_TYPE, safeMime);
            cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/bjtu-helper");
            // 允许覆盖同名文件，否则重复下载同名课件会得到 "name (1).ext"
            cv.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = null;
            try {
                uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return "无法创建下载文件（存储空间不足？）";
                try (java.io.OutputStream os = ctx.getContentResolver().openOutputStream(uri)) {
                    if (os == null) return "无法写入下载文件";
                    os.write(bytes);
                    os.flush();
                }
                cv.clear();
                cv.put(MediaStore.Downloads.IS_PENDING, 0);
                ctx.getContentResolver().update(uri, cv, null, null);
                return "";
            } catch (Exception e) {
                if (uri != null) {
                    try { ctx.getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
                }
                return "保存失败：" + e.getMessage();
            }
        }

        // ---- API < 29：应用外部私有目录 ----
        try {
            File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "");
            if (!dir.exists() && !dir.mkdirs()) return "无法创建下载目录";
            File f = new File(dir, safeName);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(bytes);
                fos.flush();
            }
            return "";
        } catch (Exception e) {
            return "保存失败：" + e.getMessage();
        }
    }

    /** 去掉路径分隔符与 Windows/Android 都不接受的字符，并限制长度 */
    private static String sanitize(String name) {
        if (name == null || name.trim().isEmpty()) return "file";
        String s = name.replaceAll("[/\\\\:*?\"<>|\\x00-\\x1f]", "_").replaceAll("^\\.+", "").trim();
        if (s.isEmpty()) s = "file";
        return s.length() > 120 ? s.substring(0, 120) : s;
    }
}
