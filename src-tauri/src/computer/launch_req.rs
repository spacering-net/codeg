//! Launch requirements: the kernel's own check of what a spawn may run.
//!
//! A process launched from a file the same user can write is only as trusted
//! as that file at the instant of `exec`. Hashing the file first and checking
//! the running image afterwards both leave a gap: swap the file between the
//! hash and the `exec`, then send the new child `SIGCONT` before the check
//! finishes — a child started suspended is stopped by a signal any process of
//! the same user may undo — and the swapped image runs, with its parent's TCC
//! responsibility, for as long as the check takes.
//!
//! A launch requirement closes the gap in the kernel. Attached to the spawn
//! attributes (`amfi_launch_constraint_set_spawnattr`, the call behind
//! `NSTask.launchRequirementData`, macOS 14.4+), it is evaluated by AMFI
//! against the image being `exec`ed; an image that does not satisfy it is
//! killed before its first instruction. Measured on macOS 27: the pinned
//! cua-driver starts, `/bin/echo` under the same requirement is killed with
//! `SIGKILL` and prints nothing. What a satisfied requirement pins is the code
//! directory; the kernel then validates every page against it as the page is
//! loaded, so no byte outside the signed build can execute.
//!
//! The kernel holds a launch to its requirement only while System Integrity
//! Protection is on. With it off — GitHub's hosted macOS runners run that way
//! — an image outside its requirement simply runs, and the check of the
//! running image before it is resumed is all that is left.
//!
//! The requirement travels as a CoreEntitlements DER dictionary,
//! `{ccat: 0, comp: 1, reqs: {…facts}, vers: 1}`. The encoder below writes
//! exactly the subset used here and is pinned, byte for byte, to what Apple's
//! own `LaunchCodeRequirement` produces for the same facts (see the tests).

use std::ffi::c_int;

/// One value in a requirement dictionary.
enum Der<'a> {
    Int(i64),
    Str(&'a str),
    Bytes(Vec<u8>),
    Array(Vec<Der<'a>>),
    Dict(Vec<(&'a str, Der<'a>)>),
}

const TAG_INTEGER: u8 = 0x02;
const TAG_OCTETS: u8 = 0x04;
const TAG_UTF8: u8 = 0x0c;
const TAG_SEQUENCE: u8 = 0x30;
/// `[APPLICATION 16]`, constructed: the whole requirement.
const TAG_ROOT: u8 = 0x70;
/// `[CONTEXT 16]`, constructed: a dictionary.
const TAG_DICT: u8 = 0xb0;

fn push_len(out: &mut Vec<u8>, len: usize) {
    if len < 0x80 {
        out.push(len as u8);
        return;
    }
    let bytes = len.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    out.push(0x80 | (bytes.len() - skip) as u8);
    out.extend_from_slice(&bytes[skip..]);
}

fn push_tlv(out: &mut Vec<u8>, tag: u8, content: &[u8]) {
    out.push(tag);
    push_len(out, content.len());
    out.extend_from_slice(content);
}

/// Two's complement, big-endian, in as few bytes as keep the sign.
fn int_bytes(v: i64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let mut start = 0;
    while start < bytes.len() - 1 {
        let (b, next) = (bytes[start], bytes[start + 1]);
        let redundant = (b == 0x00 && next & 0x80 == 0) || (b == 0xff && next & 0x80 != 0);
        if !redundant {
            break;
        }
        start += 1;
    }
    bytes[start..].to_vec()
}

fn encode(value: &Der<'_>, out: &mut Vec<u8>) {
    match value {
        Der::Int(v) => push_tlv(out, TAG_INTEGER, &int_bytes(*v)),
        Der::Str(s) => push_tlv(out, TAG_UTF8, s.as_bytes()),
        Der::Bytes(b) => push_tlv(out, TAG_OCTETS, b),
        Der::Array(items) => {
            let mut content = Vec::new();
            for item in items {
                encode(item, &mut content);
            }
            push_tlv(out, TAG_SEQUENCE, &content);
        }
        Der::Dict(entries) => {
            // CoreEntitlements looks keys up by binary search: they must be in
            // byte order.
            let mut sorted: Vec<&(&str, Der<'_>)> = entries.iter().collect();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            let mut content = Vec::new();
            for (key, value) in sorted {
                let mut pair = Vec::new();
                push_tlv(&mut pair, TAG_UTF8, key.as_bytes());
                encode(value, &mut pair);
                push_tlv(&mut content, TAG_SEQUENCE, &pair);
            }
            push_tlv(out, TAG_DICT, &content);
        }
    }
}

/// `validation-category` for code signed with a Developer ID certificate.
const VALIDATION_DEVELOPER_ID: i64 = 6;

/// The whole requirement for `facts`, as `NSTask.launchRequirementData` holds
/// it.
fn requirement(facts: Vec<(&str, Der<'_>)>) -> Vec<u8> {
    let dict = Der::Dict(vec![
        ("ccat", Der::Int(0)),
        ("comp", Der::Int(1)),
        ("reqs", Der::Dict(facts)),
        ("vers", Der::Int(1)),
    ]);
    let mut content = Vec::new();
    encode(&Der::Int(1), &mut content);
    encode(&dict, &mut content);
    let mut out = Vec::new();
    push_tlv(&mut out, TAG_ROOT, &content);
    out
}

fn hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Developer-ID-signed code from `team_id`, with signing identifier
/// `identifier`, whose code directory hash is one of `cdhashes` (hex).
pub fn pinned_build(team_id: &str, identifier: &str, cdhashes: &[&str]) -> Option<Vec<u8>> {
    let hashes = cdhashes
        .iter()
        .map(|h| hex(h).map(Der::Bytes))
        .collect::<Option<Vec<_>>>()?;
    Some(requirement(vec![
        ("cdhash", Der::Dict(vec![("$in", Der::Array(hashes))])),
        ("signing-identifier", Der::Str(identifier)),
        ("team-identifier", Der::Str(team_id)),
        ("validation-category", Der::Int(VALIDATION_DEVELOPER_ID)),
    ]))
}

/// Developer-ID-signed code from `team_id` with signing identifier
/// `identifier`, any build.
pub fn signed_by(team_id: &str, identifier: &str) -> Vec<u8> {
    requirement(vec![
        ("signing-identifier", Der::Str(identifier)),
        ("team-identifier", Der::Str(team_id)),
        ("validation-category", Der::Int(VALIDATION_DEVELOPER_ID)),
    ])
}

type SetFn = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, *const u8, usize) -> c_int;

fn set_fn() -> Option<SetFn> {
    static NAME: &[u8] = b"amfi_launch_constraint_set_spawnattr\0";
    // SAFETY: RTLD_DEFAULT with a NUL-terminated name; the symbol, when
    // present (libSystem, macOS 14.4+), takes the attributes, the encoded
    // requirement and its length.
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast()) };
    if sym.is_null() {
        None
    } else {
        // SAFETY: see above.
        Some(unsafe { std::mem::transmute::<*mut libc::c_void, SetFn>(sym) })
    }
}

/// Whether this macOS can attach a launch requirement to a spawn.
pub fn supported() -> bool {
    set_fn().is_some()
}

/// Whether the kernel here can be counted on to hold a launch to its
/// requirement: System Integrity Protection is wholly on. The tests that
/// prove the kernel refuses an image have nothing to prove anywhere else.
#[cfg(test)]
pub(crate) fn held_here() -> bool {
    extern "C" {
        fn csr_get_active_config(config: *mut u32) -> c_int;
    }
    let mut config = 0u32;
    // SAFETY: writes one `csr_config_t` (a `u32`) through a valid pointer.
    unsafe { csr_get_active_config(&mut config) == 0 && config == 0 }
}

/// Attach `requirement` to `attr`, so the kernel refuses to run any image
/// that does not satisfy it.
///
/// # Safety
///
/// `attr` must be an initialised `posix_spawnattr_t`.
pub unsafe fn apply(
    attr: &mut libc::posix_spawnattr_t,
    requirement: &[u8],
) -> std::io::Result<()> {
    let set = set_fn().ok_or_else(|| {
        std::io::Error::other(
            "computer use needs macOS 14.4 or later, the first to let a launch be held to a \
             code requirement",
        )
    })?;
    // SAFETY: the caller's contract for `attr`; the requirement slice is valid
    // for the call.
    let rc = unsafe { set(attr, requirement.as_ptr(), requirement.len()) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "the launch requirement was not accepted (error {rc})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        hex(s).unwrap()
    }

    /// Byte for byte what `LaunchCodeRequirement.allOf { TeamIdentifier(…);
    /// SigningIdentifier(…); CodeDirectoryHash.in(…); ValidationCategory(
    /// .developerID) }` puts in `NSTask.launchRequirementData` (macOS 27).
    #[test]
    fn the_driver_requirement_is_what_apple_encodes() {
        let apple = unhex(
            "7081cf020101b081c930090c046363617402010030090c04636f6d700201013081a50c0472\
             657173b0819c303f0c06636468617368b03530330c0324696e302c0414f39eb6bac5737b\
             09d32467dfd07da4cd5b64d9a204140f36b964a2420bc8da06f59163ad9fe46e9edc5130\
             200c127369676e696e672d6964656e7469666965720c0a6375612d647269766572301d0c\
             0f7465616d2d6964656e7469666965720c0a59434b3338364c424a3730180c1376616c69\
             646174696f6e2d63617465676f727902010630090c0476657273020101",
        );
        let ours = pinned_build(
            "YCK386LBJ7",
            "cua-driver",
            &[
                "f39eb6bac5737b09d32467dfd07da4cd5b64d9a2",
                "0f36b964a2420bc8da06f59163ad9fe46e9edc51",
            ],
        )
        .unwrap();
        assert_eq!(ours, apple);
    }

    /// The same for team, identifier and category alone.
    #[test]
    fn the_helper_requirement_is_what_apple_encodes() {
        let apple = unhex(
            "708197020101b0819130090c046363617402010030090c04636f6d70020101306e0c0472\
             657173b066302b0c127369676e696e672d6964656e7469666965720c15636f6465672d63\
             6f6d70757465722d68656c706572301d0c0f7465616d2d6964656e7469666965720c0a41\
             42434445313233343530180c1376616c69646174696f6e2d63617465676f727902010630\
             090c0476657273020101",
        );
        assert_eq!(signed_by("ABCDE12345", "codeg-computer-helper"), apple);
    }

    #[test]
    fn integers_and_lengths_take_their_shortest_form() {
        assert_eq!(int_bytes(0), vec![0x00]);
        assert_eq!(int_bytes(6), vec![0x06]);
        assert_eq!(int_bytes(128), vec![0x00, 0x80]);
        assert_eq!(int_bytes(-1), vec![0xff]);
        let mut out = Vec::new();
        push_len(&mut out, 0x7f);
        push_len(&mut out, 0xc9);
        push_len(&mut out, 0x1234);
        assert_eq!(out, vec![0x7f, 0x81, 0xc9, 0x82, 0x12, 0x34]);
        assert!(pinned_build("T", "i", &["zz"]).is_none());
    }
}
