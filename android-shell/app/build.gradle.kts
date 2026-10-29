plugins {
    id("com.android.application")
}

android {
    namespace = "com.bjtu.helper"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.bjtu.helper"
        // minSdk 24 覆盖 Android 7.0+；如需更旧机型可下调到 21
        minSdk = 24
        targetSdk = 36
        versionCode = 10
        versionName = "1.9"
    }

    buildTypes {
        release {
            // 纯 WebView 壳，无混淆规则需求；保持可读便于二次维护
            isMinifyEnabled = false
        }
        debug {
            // 便于日志调试
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 本壳只依赖 Android 框架内置的 WebView / Calendar / Activity 等类，无需任何三方 androidx 依赖，
// 因此离线环境下也几乎必然能构建成功，降低 AGP/Kotlin/仓库不可达带来的构建风险。
dependencies {
}
