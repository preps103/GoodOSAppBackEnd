plugins {
    id("com.android.library") version "8.7.3"
    kotlin("android") version "2.1.10"
    id("maven-publish")
}

group = "app.goodos"
version = "0.1.0"

android {
    namespace = "app.goodos.goodbase"
    compileSdk = 35
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    defaultConfig { minSdk = 26; consumerProguardFiles("consumer-rules.pro"); externalNativeBuild { cmake { cppFlags += "-std=c++17" } } }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    publishing { singleVariant("release") { withSourcesJar() } }
}

kotlin { jvmToolchain(17) }

dependencies { implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1") }

publishing { publications { register<MavenPublication>("release") { afterEvaluate { from(components["release"]) }; pom { name.set("Goodbase Android SDK"); description.set("Official Goodbase Android and NDK client") } } } }
