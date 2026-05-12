# Keep kotlinx.serialization classes
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.gamebot.**$$serializer { *; }
-keepclassmembers class com.gamebot.** { *** Companion; }
-keepclasseswithmembers class com.gamebot.** { kotlinx.serialization.KSerializer serializer(...); }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
