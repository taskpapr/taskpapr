import java.util.Properties

plugins {
    id("com.android.application")
}

// One version for the whole product: versionName comes from the server's
// package.json, and versionCode is derived from it (0.46.4 -> 46004), so the
// app never needs a separate manual bump. A pre-release suffix (0.47.0-rc.1)
// is ignored for the code.
val versionParts: List<Int> = Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)")
    .find(rootDir.resolve("../package.json").readText())
    ?.groupValues?.drop(1)?.map(String::toInt)
    ?: error("Couldn't read an X.Y.Z version from ../package.json")
val appVersion: String = versionParts.joinToString(".")
val appVersionCode: Int = versionParts.let { (major, minor, patch) ->
    // Each part gets three digits; beyond that, codes would collide or go
    // backwards and Android would refuse the upgrade.
    require(minor < 1000 && patch < 1000) { "versionCode scheme needs minor and patch < 1000 (got $appVersion)" }
    major * 1_000_000 + minor * 1_000 + patch
}

// Release signing material lives outside the repo (see android/README.md).
// Point TASKPAPR_KEYSTORE_PROPERTIES, or the Gradle property
// taskpapr.keystoreProperties, at a properties file with storeFile,
// storePassword, keyAlias and keyPassword. Without it, release builds are
// produced unsigned and can't be installed.
val keystorePropertiesPath: String? = System.getenv("TASKPAPR_KEYSTORE_PROPERTIES")
    ?: providers.gradleProperty("taskpapr.keystoreProperties").orNull
val keystoreProperties: Properties? = keystorePropertiesPath?.let { path ->
    val propsFile = file(path)
    require(propsFile.isFile) { "Signing properties file not found: $path (TASKPAPR_KEYSTORE_PROPERTIES)" }
    Properties().apply { propsFile.inputStream().use(::load) }.also { props ->
        val missing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
            .filter { props.getProperty(it).isNullOrBlank() }
        require(missing.isEmpty()) { "$path is missing: ${missing.joinToString()}" }
        val store = file(props.getProperty("storeFile"))
        require(store.isFile) { "Keystore not found: $store (storeFile in $path; use an absolute path, not ~)" }
    }
}

// The site's Digital Asset Links statement, which the app declares so the
// verification works in both directions. Quotes are escaped for the string
// resource that resValue generates.
fun assetStatements(origin: String): String =
    """[{\"relation\": [\"delegate_permission/common.handle_all_urls\"], """ +
        """\"target\": {\"namespace\": \"web\", \"site\": \"$origin\"}}]"""

android {
    namespace = "com.taskpapr.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.taskpapr.app"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersion
    }

    flavorDimensions += "server"
    productFlavors {
        create("prod") {
            dimension = "server"
            resValue("string", "app_name", "taskpapr")
            resValue("string", "launch_url", "https://app.taskpapr.com/")
            resValue("string", "asset_statements", assetStatements("https://app.taskpapr.com"))
        }
        create("staging") {
            dimension = "server"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "taskpapr staging")
            resValue("string", "launch_url", "https://taskpapr-staging.onrender.com/")
            resValue("string", "asset_statements", assetStatements("https://taskpapr-staging.onrender.com"))
        }
    }

    signingConfigs {
        if (keystoreProperties != null) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        resValues = true
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
