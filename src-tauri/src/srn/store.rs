//! The sign-in, as the keychain keeps it.
//!
//! One named secret (`keyring_store`'s, which on the desktop is the OS
//! keychain; its name is the environment's, `environment.rs`) holding a small
//! JSON record: the token, and the identity it was last confirmed for — so
//! that Codeg started offline still knows who is signed in, only not that
//! SpaceRing agrees. The keychain is not part of Codeg's backup, and this is
//! the only place the token is written.
//!
//! The store is a trait so that tests use one in memory: nothing here, or in
//! the account service, ever touches a real keychain in a test.

use serde::{Deserialize, Serialize};

use super::client::{avatar_path, clean_name, SrnUser};
use super::pkce::AccessToken;
use crate::harness::origin::Origin;

/// Where the record is kept. Blocking: called off the async threads.
pub(crate) trait SecretStore: Send + Sync + 'static {
    /// `Ok(None)`: nothing is kept under `name`. `Err`: the store would not
    /// say — which is not the same thing, and is never treated as it.
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Removing what is not there is not a failure.
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// The OS keychain, through `keyring_store`'s named secrets.
pub(crate) struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        crate::keyring_store::get_secret(name)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        crate::keyring_store::set_secret(name, value)
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        crate::keyring_store::delete_secret(name)
    }
}

/// The record's version: what this Codeg writes.
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Record {
    v: u32,
    token: String,
    srn: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    avatar: Option<String>,
}

/// The record for `token`, signed in as `user`.
pub(crate) fn encode(token: &AccessToken, user: &SrnUser) -> String {
    serde_json::to_string(&Record {
        v: VERSION,
        token: token.expose().to_string(),
        srn: user.srn,
        name: user.name.clone(),
        avatar: user.avatar_path.clone(),
    })
    .expect("a record of strings and numbers serializes")
}

/// What a record holds, if it is one: a token of the right shape and an SRN.
/// Fields a later Codeg may add are ignored; an avatar that is not a path
/// SpaceRing serves on `origin` is dropped, as from an answer.
pub(crate) fn decode(raw: &str, origin: &Origin) -> Option<(AccessToken, SrnUser)> {
    let record: Record = serde_json::from_str(raw).ok()?;
    let token = AccessToken::parse(&record.token)?;
    if record.srn == 0 {
        return None;
    }
    let avatar_path = record
        .avatar
        .and_then(|path| avatar_path(&format!("{}{path}", origin.as_str()), origin));
    Some((
        token,
        SrnUser {
            srn: record.srn,
            name: clean_name(&record.name),
            avatar_path,
        },
    ))
}

#[cfg(test)]
pub(crate) mod memory {
    //! A keychain in memory, which can be told to fail.

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use super::SecretStore;

    #[derive(Default)]
    pub(crate) struct MemoryStore {
        pub values: Mutex<HashMap<String, String>>,
        pub fail_get: Mutex<bool>,
        pub fail_set: Mutex<bool>,
        pub fail_delete: Mutex<bool>,
        /// Shared with the stand-in for SpaceRing, to tell the order things
        /// happened in.
        pub journal: Arc<Mutex<Vec<String>>>,
    }

    impl MemoryStore {
        pub fn with_journal(journal: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                journal,
                ..Self::default()
            }
        }

        pub fn value(&self, name: &str) -> Option<String> {
            self.values.lock().unwrap().get(name).cloned()
        }

        pub fn put(&self, name: &str, value: &str) {
            self.values
                .lock()
                .unwrap()
                .insert(name.to_string(), value.to_string());
        }

        fn note(&self, what: &str) {
            self.journal.lock().unwrap().push(format!("store {what}"));
        }
    }

    impl SecretStore for MemoryStore {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            self.note("get");
            if *self.fail_get.lock().unwrap() {
                return Err("keyring get error: the keychain is locked".into());
            }
            Ok(self.value(name))
        }

        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.note("set");
            if *self.fail_set.lock().unwrap() {
                return Err("keyring set error: the keychain is locked".into());
            }
            self.put(name, value);
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            self.note("delete");
            if *self.fail_delete.lock().unwrap() {
                return Err("keyring delete error: the keychain is locked".into());
            }
            self.values.lock().unwrap().remove(name);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(avatar: Option<&str>) -> SrnUser {
        SrnUser {
            srn: 10_000,
            name: "Ada".into(),
            avatar_path: avatar.map(str::to_string),
        }
    }

    #[test]
    fn a_record_keeps_the_token_and_who_it_is_for() {
        let origin = Origin::release();
        let token = AccessToken::parse(&"t".repeat(43)).unwrap();
        let user = user(Some("/api/avatars/u-1/a.png"));
        let (back, who) = decode(&encode(&token, &user), &origin).unwrap();
        assert_eq!(back, token);
        assert_eq!(who, user);
    }

    #[test]
    fn what_is_not_a_record_is_not_one() {
        let origin = Origin::release();
        let token = "t".repeat(43);
        for bad in [
            String::new(),
            "not json".to_string(),
            token.clone(),
            r#"{"v":1}"#.to_string(),
            r#"{"v":1,"token":"short","srn":1}"#.to_string(),
            format!(r#"{{"v":1,"token":"{token}","srn":0}}"#),
            format!(r#"{{"v":1,"token":"{token}","srn":"1"}}"#),
            format!(r#"{{"v":1,"token":"{token}"}}"#),
        ] {
            assert!(decode(&bad, &origin).is_none(), "{bad}");
        }
        // a later version's extra fields are fine, and an avatar that is
        // not one is dropped
        let (_, who) = decode(
            &format!(
                r#"{{"v":2,"token":"{token}","srn":7,"name":"B","avatar":"/api/me","extra":true}}"#
            ),
            &origin,
        )
        .unwrap();
        assert_eq!(who.srn, 7);
        assert_eq!(who.avatar_path, None);
    }
}
