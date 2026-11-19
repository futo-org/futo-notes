use jni::objects::JObject;
use jni::sys::{jboolean, JNI_FALSE, JNI_TRUE};
use jni::EnvUnowned;

#[no_mangle]
pub extern "system" fn Java_com_futo_notes_PlatformTrust_initialize<'l>(
    mut env: EnvUnowned<'l>,
    _class: JObject<'l>,
    context: JObject<'l>,
) -> jboolean {
    let bound = env.with_env(|env| -> jni::errors::Result<jboolean> {
        Ok(match futo_notes_sync::install_android_trust(env, context) {
            Ok(()) => JNI_TRUE,
            Err(_) => {
                env.exception_clear();
                JNI_FALSE
            }
        })
    });
    // A panic is a failed binding too: the app stays usable offline and only
    // sync refuses (apps/android/AGENTS.md), never a crash at launch.
    match bound.into_outcome() {
        jni::Outcome::Ok(bound) => bound,
        _ => JNI_FALSE,
    }
}
