package com.bjtu.helper;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 桌面小组件 · 标准版（默认 4×2，可自由缩放）。
 *
 * 与完整版（{@link ScheduleWidgetProvider}）共用同一份布局与列表服务，
 * 区别只有两处：默认格子更矮（4×2），课程行用**单行紧凑模式**（MODE_COMPACT）——
 * 4×2 的高度只够铺 1~2 行两行式课程，紧凑行一节课一行，信息密度才对。
 */
public class ScheduleWidgetMediumProvider extends BaseScheduleWidget {

    @Override
    ComponentName componentName(Context context) {
        return new ComponentName(context, ScheduleWidgetMediumProvider.class);
    }

    @Override
    int listViewId() {
        return R.id.course_list;
    }

    @Override
    RemoteViews build(Context context, int appWidgetId) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_schedule);
        JSONObject snap = WidgetDataStore.load(context);

        rv.setTextViewText(R.id.widget_title, context.getString(R.string.app_name));
        rv.setTextViewText(R.id.widget_date, todayLabel() + weekLabel(snap));

        Intent svc = new Intent(context, ScheduleWidgetListService.class)
                .putExtra(ScheduleWidgetListService.EXTRA_MODE, ScheduleWidgetListService.MODE_COMPACT);
        rv.setRemoteAdapter(appWidgetId, R.id.course_list, svc);
        rv.setPendingIntentTemplate(R.id.course_list, openAppIntent(context));

        renderDdlFooter(context, rv, snap);
        rv.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context));
        return rv;
    }
}
