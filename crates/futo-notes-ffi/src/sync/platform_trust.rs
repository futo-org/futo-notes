use jni::objects::JObject;
use jni::sys::{jboolean, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

#[no_mangle]
pub extern "system" fn Java_com_futo_notes_PlatformTrust_initialize(
    mut env: JNIEnv,
    _class: JObject,
    context: JObject,
) -> jboolean {
    match futo_notes_sync::install_android_trust(&mut env, context) {
        Ok(()) => JNI_TRUE,
        Err(_) => {
            let _ = env.exception_clear();
            JNI_FALSE
        }
    }
}
