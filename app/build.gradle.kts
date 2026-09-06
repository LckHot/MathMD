import java.util.Base64

plugins {
    id("com.android.application")
    // AGP 9.3.2 built-in Kotlin is 2.2.10; the Compose compiler plugin must match.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10"
}

android {
    namespace = "io.github.lckhot.mathmd"
    // Compile against API 37 (required by Compose BOM 2026.08.00 libs);
    // targetSdk stays 36 per current Google Play policy.
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.lckhot.mathmd"
        minSdk = 29
        targetSdk = 36
        versionCode = 17
        versionName = "1.1.0"
    }

    // CI signing (GitHub Actions): secrets provide base64 keystore + passwords.
    // BOTH variants then carry the release signature — debug included — so
    // test builds install as upgrades over the released app (a runner-random
    // debug key would be blocked with INSTALL_FAILED_UPDATE_INCOMPATIBLE).
    // Locally (no env): release is unsigned, debug uses the standard debug
    // keystore. Missing GH secrets arrive as EMPTY strings, not null.
    val storeB64 = System.getenv("MATHMD_RELEASE_STORE_B64")
    val storePass = System.getenv("MATHMD_RELEASE_STORE_PASS")
    val keyAlias = System.getenv("MATHMD_RELEASE_KEY_ALIAS") ?: "mathmd"
    val ciSigning = if (!storeB64.isNullOrEmpty() && !storePass.isNullOrEmpty()) {
        val keystoreFile = layout.buildDirectory.file("release.keystore").get().asFile
        keystoreFile.parentFile.mkdirs()
        keystoreFile.writeBytes(Base64.getDecoder().decode(storeB64))
        signingConfigs.create("release") {
            storeFile = keystoreFile
            storePassword = storePass
            this.keyAlias = keyAlias
            keyPassword = storePass
        }
    } else {
        null
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            ciSigning?.let { signingConfig = it }
        }
        debug {
            // Test APKs from build-test.yml ship release-signed (see above).
            ciSigning?.let { signingConfig = it }
        }
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.08.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.13.0")
}
