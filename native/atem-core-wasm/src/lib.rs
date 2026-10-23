//! Atem's atem-core-ffi (C ABI 1) for the Portal's JavaScript host. The token functions are atem-core-ffi's own
//! exports, unchanged; this crate only adds an allocator so the host can pass parameter structs and C strings.

pub use atem_core_ffi::*;

use std::alloc::{Layout, alloc, dealloc};

const ALIGN: usize = 8;

/// Allocates `size` bytes for the host (NULL when `size` is 0 or too large).
#[unsafe(no_mangle)]
pub extern "C" fn portal_alloc(size: usize) -> *mut u8 {
    match Layout::from_size_align(size, ALIGN) {
        Ok(layout) if size > 0 => unsafe { alloc(layout) },
        _ => std::ptr::null_mut(),
    }
}

/// Frees memory from `portal_alloc` with the same `size`.
///
/// # Safety
/// `ptr` came from `portal_alloc(size)` and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn portal_free(ptr: *mut u8, size: usize) {
    if let Ok(layout) = Layout::from_size_align(size, ALIGN) {
        if !ptr.is_null() && size > 0 {
            unsafe { dealloc(ptr, layout) };
        }
    }
}

// wasm32-unknown-unknown has no random source, so the host supplies one: `env.portal_random(ptr, len)` fills the
// bytes from Node's crypto. atem-core draws a salt even when the host passes its own (Issue::at), so this is needed.
// The host also always passes `issued_at`, because this target has no clock.
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn portal_random(ptr: *mut u8, len: usize) -> i32;
}

fn host_randomness(bytes: &mut [u8]) -> Result<(), getrandom::Error> {
    match unsafe { portal_random(bytes.as_mut_ptr(), bytes.len()) } {
        0 => Ok(()),
        _ => Err(getrandom::Error::UNSUPPORTED),
    }
}
getrandom::register_custom_getrandom!(host_randomness);
