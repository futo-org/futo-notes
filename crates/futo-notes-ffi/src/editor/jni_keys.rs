//! The per-keystroke editor calls as plain
//! JNI functions for the Android text-first editor. The UniFFI Kotlin
//! bindings cross through JNA, which on the Moto g play costs several
//! reflective Structure allocations per call (~2 ms a key). These functions
//! take the same arguments, call the same `NativeEditorSession` methods, and
//! return the result in UniFFI's own byte encoding, so Kotlin decodes it with
//! the generated `FfiConverterType…` readers: one codec, a cheaper crossing.
//!
//! Result bytes: `0` + EditorViewChange, `1` + EditorSessionError, `2` (no change).
use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JCharArray, JClass};
use jni::sys::{jbyteArray, jint, jlong};
use jni::{Env, EnvUnowned};
use uniffi::Lower;

use super::{
    EditorInputAction, EditorParagraphKey, EditorSessionError, EditorUtf16Range, EditorViewChange,
    NativeEditorSession,
};
use crate::UniFfiTag;

type Outcome = Result<Option<EditorViewChange>, EditorSessionError>;

fn encode(outcome: Outcome) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);
    match outcome {
        Ok(Some(change)) => {
            buf.push(0);
            <EditorViewChange as Lower<UniFfiTag>>::write(change, &mut buf);
        }
        Err(error) => {
            buf.push(1);
            <EditorSessionError as Lower<UniFfiTag>>::write(error, &mut buf);
        }
        Ok(None) => buf.push(2),
    }
    buf
}

/// The session behind a handle from `uniffiCloneHandle()`; the caller keeps
/// that clone alive until `release`.
///
/// # Safety
/// `handle` must be a live clone of a NativeEditorSession handle.
unsafe fn session<'a>(handle: jlong) -> &'a NativeEditorSession {
    &*(handle as u64 as *const NativeEditorSession)
}

fn respond<'l>(env: &mut EnvUnowned<'l>, work: impl FnOnce(&mut Env<'l>) -> Outcome) -> jbyteArray {
    // The work's own panic becomes a typed `Unavailable` result, as before;
    // `with_env_no_catch` because nothing else in here can panic.
    let array = env.with_env_no_catch(|env| -> jni::errors::Result<jbyteArray> {
        let bytes = match catch_unwind(AssertUnwindSafe(|| encode(work(env)))) {
            Ok(bytes) => bytes,
            Err(_) => encode(Err(EditorSessionError::Unavailable)),
        };
        Ok(env.byte_array_from_slice(&bytes)?.into_raw())
    });
    match array.into_outcome() {
        jni::Outcome::Ok(array) => array,
        _ => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_futo_notes_textfirst_FastKeys_replace<'l>(
    mut env: EnvUnowned<'l>,
    _class: JClass<'l>,
    handle: jlong,
    expected: jlong,
    start: jint,
    end: jint,
    inserted: JCharArray<'l>,
    action: jint,
) -> jbyteArray {
    respond(&mut env, |env| {
        // Copy exact UTF-16 units, including lone surrogates. Only the engine
        // decides whether an OS-provided sequence is representable.
        let len = inserted
            .len(env)
            .map_err(|_| EditorSessionError::InvalidText)?;
        let mut text = vec![0u16; len];
        inserted
            .get_region(env, 0, &mut text)
            .map_err(|_| EditorSessionError::InvalidText)?;
        let action = input_action(action)?;
        let range = input_range(start, end)?;
        // SAFETY: Kotlin holds the cloned handle for the engine's lifetime.
        let session = unsafe { session(handle) };
        session
            .replace_utf16_action(expected as u64, range, text, action)
            .map(Some)
    })
}

#[no_mangle]
pub extern "system" fn Java_com_futo_notes_textfirst_FastKeys_paragraphKey<'l>(
    mut env: EnvUnowned<'l>,
    _class: JClass<'l>,
    handle: jlong,
    expected: jlong,
    start: jint,
    end: jint,
    key: jint,
) -> jbyteArray {
    respond(&mut env, |_| {
        let key = paragraph_key(key)?;
        let range = input_range(start, end)?;
        // SAFETY: as above.
        unsafe { session(handle) }.paragraph_key_utf16(expected as u64, range, key)
    })
}

fn input_action(value: jint) -> Result<EditorInputAction, EditorSessionError> {
    match value {
        0 => Ok(EditorInputAction::Typing),
        1 => Ok(EditorInputAction::Isolated),
        2 => Ok(EditorInputAction::CompositionCommit),
        _ => Err(EditorSessionError::InvalidRange),
    }
}

fn paragraph_key(value: jint) -> Result<EditorParagraphKey, EditorSessionError> {
    match value {
        0 => Ok(EditorParagraphKey::Enter),
        1 => Ok(EditorParagraphKey::ShiftEnter),
        2 => Ok(EditorParagraphKey::Backspace),
        3 => Ok(EditorParagraphKey::Delete),
        4 => Ok(EditorParagraphKey::Tab),
        5 => Ok(EditorParagraphKey::ShiftTab),
        6 => Ok(EditorParagraphKey::BackspaceJoiningHeading),
        _ => Err(EditorSessionError::InvalidRange),
    }
}

fn input_range(start: jint, end: jint) -> Result<EditorUtf16Range, EditorSessionError> {
    Ok(EditorUtf16Range {
        start: start
            .try_into()
            .map_err(|_| EditorSessionError::InvalidRange)?,
        end: end
            .try_into()
            .map_err(|_| EditorSessionError::InvalidRange)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_ordinals_and_negative_offsets_are_typed_failures() {
        assert!(input_action(-1).is_err());
        assert!(input_action(3).is_err());
        assert!(paragraph_key(-1).is_err());
        assert_eq!(
            paragraph_key(6).unwrap(),
            EditorParagraphKey::BackspaceJoiningHeading
        );
        assert!(paragraph_key(7).is_err());
        assert!(input_range(-1, 0).is_err());
        assert!(input_range(0, -1).is_err());
        assert_eq!(input_range(0, i32::MAX).unwrap().end, i32::MAX as u64);
    }

    #[test]
    fn no_change_and_error_use_distinct_tagged_uniffi_payloads() {
        assert_eq!(encode(Ok(None)), vec![2]);
        let encoded = encode(Err(EditorSessionError::InvalidRange));
        assert_eq!(encoded[0], 1);
        assert!(encoded.len() > 1);
    }
}

/// Drops the handle clone Kotlin took for these calls.
#[no_mangle]
pub extern "system" fn Java_com_futo_notes_textfirst_FastKeys_release<'l>(
    _env: EnvUnowned<'l>,
    _class: JClass<'l>,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: the clone came from uniffiCloneHandle (an Arc::into_raw) and is released once.
        drop(unsafe { std::sync::Arc::from_raw(handle as u64 as *const NativeEditorSession) });
    }
}
