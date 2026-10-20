//! In-process mutation server tests for the cycle runner.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use futo_notes_core::journal::{read_events, Journal, JournalLimits};

use super::*;
use crate::journal::SyncTrigger;

mod checkpoint_failures;
mod journaling;
mod mutation_server;

use mutation_server::{connected, MutationServer, TempRoot};
