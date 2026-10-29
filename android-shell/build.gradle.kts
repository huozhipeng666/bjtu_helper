// 顶层构建脚本：仅声明 AGP 插件版本，供 app 模块使用。本壳为纯 Java WebView，无 Compose/Kotlin 插件。
plugins {
    id("com.android.application") version "9.3.1" apply false
}
