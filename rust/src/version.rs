//! Transaction message version identification.

use std::fmt;

/// The version of a transaction message.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum MessageVersion {
    Legacy,
    V0,
    V1,
}

impl fmt::Display for MessageVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Legacy => "legacy",
            Self::V0 => "v0",
            Self::V1 => "v1",
        };
        f.write_str(name)
    }
}

/// A running count of transaction versions, used by the block examples.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VersionTally {
    pub legacy: u64,
    pub v0: u64,
    pub v1: u64,
}

impl VersionTally {
    pub fn record(&mut self, version: MessageVersion) {
        match version {
            MessageVersion::Legacy => self.legacy += 1,
            MessageVersion::V0 => self.v0 += 1,
            MessageVersion::V1 => self.v1 += 1,
        }
    }

    pub fn total(&self) -> u64 {
        self.legacy + self.v0 + self.v1
    }
}

impl fmt::Display for VersionTally {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "legacy={} v0={} v1={}", self.legacy, self.v0, self.v1)
    }
}
