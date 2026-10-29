package com.bjtu.helper;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.util.Log;

/**
 * 保证存在一个归属于本 App 的系统日历账号，便于集中写入与管理（避免污染用户的 Google 日历）。
 * 纯框架实现，无三方依赖。
 */
final class CalendarHelper {

    private static final String TAG = "BjtuCal";
    private static final String ACCOUNT_NAME = "bjtu-helper";
    private static final String ACCOUNT_TYPE = "bjtu.helper.calendar";

    private CalendarHelper() {}

    /** 找到或创建一个本应用专用的日历，返回其 id。 */
    static long ensureAppCalendar(ContentResolver cr) {
        // 先查是否已有
        try (Cursor c = cr.query(
                CalendarContract.Calendars.CONTENT_URI,
                new String[]{CalendarContract.Calendars._ID},
                CalendarContract.Calendars.ACCOUNT_NAME + "=? AND " + CalendarContract.Calendars.ACCOUNT_TYPE + "=?",
                new String[]{ACCOUNT_NAME, ACCOUNT_TYPE},
                null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        } catch (Exception e) {
            Log.w(TAG, "query calendar failed", e);
        }

        // 没有则创建。同步适配器字段需按 owner 账户填；此处用一个稳定值以便作为独立日历出现。
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Calendars.ACCOUNT_NAME, ACCOUNT_NAME);
        v.put(CalendarContract.Calendars.ACCOUNT_TYPE, ACCOUNT_TYPE);
        v.put(CalendarContract.Calendars.NAME, ACCOUNT_NAME);
        v.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, "交大小助手");
        v.put(CalendarContract.Calendars.CALENDAR_COLOR, 0xFF35A58F);
        v.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER);
        v.put(CalendarContract.Calendars.OWNER_ACCOUNT, ACCOUNT_NAME);
        v.put(CalendarContract.Calendars.VISIBLE, 1);
        v.put(CalendarContract.Calendars.SYNC_EVENTS, 1);

        Uri uri = buildCalUri();
        try {
            Uri inserted = cr.insert(uri, v);
            if (inserted != null) return ContentUris.parseId(inserted);
        } catch (Exception e) {
            Log.w(TAG, "insert calendar failed, will try default", e);
        }
        // 兜底：读系统默认可见的第一个日历
        try (Cursor c = cr.query(CalendarContract.Calendars.CONTENT_URI,
                new String[]{CalendarContract.Calendars._ID},
                CalendarContract.Calendars.VISIBLE + "=1", null, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        } catch (Exception ignored) {}
        return 1L;
    }

    /** 以 SyncAdapter 方式插入日历需要特定的 URI + 同步列。构造符合规范的 URI。 */
    private static Uri buildCalUri() {
        Uri.Builder b = CalendarContract.Calendars.CONTENT_URI.buildUpon();
        b.appendPath("sync");
        b.appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, ACCOUNT_NAME);
        b.appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, ACCOUNT_TYPE);
        b.appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true");
        return b.build();
    }
}
