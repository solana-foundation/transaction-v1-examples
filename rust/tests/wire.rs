//! Offline tests for the v1 wire format and version discrimination.
//!
//! Nothing here needs a validator: a v1 message can be compiled, serialized,
//! and deserialized entirely in process.

use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_signer::Signer;
use txv1::grpc::message_version;
use txv1::send::{build_v1_transfer, EXAMPLE_CONFIG};
use txv1::version::VersionTally;
use txv1::MessageVersion;
use yellowstone_grpc_proto::solana::storage::confirmed_block::{Message, TransactionConfig};

fn compile(config: v1::TransactionConfig) -> v1::Message {
    let payer = Keypair::new();
    let instruction =
        solana_system_interface::instruction::transfer(&payer.pubkey(), &Address::new_unique(), 1);
    v1::Message::try_compile_with_config(
        &payer.pubkey(),
        &[instruction],
        Hash::new_unique(),
        config,
    )
    .expect("v1 message compiles")
}

#[test]
fn serialized_v1_message_carries_the_v1_version_prefix() {
    let bytes = compile(EXAMPLE_CONFIG).serialize();
    assert_eq!(bytes[0], 0x81, "v1 messages are prefixed 0x80 | 1");
}

#[test]
fn config_round_trips_through_the_wire_format() {
    let message = compile(EXAMPLE_CONFIG);
    let bytes = message.serialize();
    // `Message::serialize` emits the 0x81 version prefix, but `v1::deserialize`
    // reads a bare message body, so the prefix has to be stripped by hand.
    let decoded = v1::deserialize(&bytes[1..]).expect("v1 message deserializes");

    assert_eq!(decoded.config, EXAMPLE_CONFIG);
    assert_eq!(decoded.config.priority_fee, Some(5_000));
    assert_eq!(decoded.config.compute_unit_limit, Some(20_000));
    assert_eq!(decoded.config.loaded_accounts_data_size_limit, Some(65_536));
    // Not 32 KB: that is the value an unset heap already resolves to, so it
    // could not distinguish a set field from an absent one.
    assert_eq!(decoded.config.heap_size, Some(65_536));
}

#[test]
fn an_empty_config_still_produces_a_v1_message() {
    let bytes = compile(v1::TransactionConfig::empty()).serialize();
    let decoded = v1::deserialize(&bytes[1..]).expect("v1 message deserializes");

    assert_eq!(bytes[0], 0x81, "an empty config is still a v1 message");
    assert_eq!(decoded.config, v1::TransactionConfig::empty());
    assert_eq!(decoded.config.compute_unit_limit, None);
    assert_eq!(decoded.config.priority_fee, None);
}

#[test]
fn the_config_holds_no_compute_budget_instructions() {
    let message = compile(EXAMPLE_CONFIG);
    assert_eq!(
        message.instructions.len(),
        1,
        "the budget lives in the config, so no ComputeBudget instructions are compiled"
    );
}

#[test]
fn v1_messages_have_no_address_table_lookups() {
    let transaction = build_v1_transfer(
        &Keypair::new(),
        &Address::new_unique(),
        1,
        Hash::new_unique(),
        EXAMPLE_CONFIG,
    )
    .expect("transfer builds");

    let VersionedMessage::V1(message) = &transaction.message else {
        panic!("expected a v1 message");
    };

    // Proving this on the wire rather than through
    // `VersionedMessage::address_table_lookups()`, which is a hardcoded
    // `V1(_) => None` arm and so can only restate the library's own match.
    let bytes = message.serialize();
    let decoded = v1::deserialize(&bytes[1..]).expect("v1 message deserializes");
    assert_eq!(
        bytes.len(),
        1 + decoded.size(),
        "a v1 message is exactly its header, config, addresses, and instructions \
         with no lookup table section"
    );
}

#[test]
fn the_config_mask_uses_two_bits_for_the_priority_fee_and_one_for_each_other_field() {
    let mask = v1::TransactionConfigMask::new(
        v1::TransactionConfigMask::PRIORITY_FEE | v1::TransactionConfigMask::HEAP_SIZE,
    );

    assert!(mask.has_priority_fee());
    assert!(mask.has_heap_size());
    assert!(!mask.has_compute_unit_limit());
    assert!(!mask.has_loaded_accounts_data_size());
    assert!(!mask.has_unknown_bits());
}

#[test]
fn a_half_set_priority_fee_mask_is_invalid() {
    // The priority fee occupies two bits; setting only one is malformed
    // rather than meaning "no fee".
    let mask = v1::TransactionConfigMask::new(0b01);
    assert!(mask.has_invalid_priority_fee_bits());
}

#[test]
fn grpc_version_discrimination_keys_on_config_not_versioned() {
    let v1_message = Message {
        config: Some(TransactionConfig::default()),
        versioned: true,
        ..Default::default()
    };
    let v0_message = Message {
        config: None,
        versioned: true,
        ..Default::default()
    };
    let legacy_message = Message {
        config: None,
        versioned: false,
        ..Default::default()
    };

    assert_eq!(message_version(&v1_message), MessageVersion::V1);
    assert_eq!(message_version(&v0_message), MessageVersion::V0);
    assert_eq!(message_version(&legacy_message), MessageVersion::Legacy);
}

#[test]
fn a_v1_message_with_an_all_unset_config_is_still_v1_on_the_wire() {
    // Every config field is optional, so a v1 message can carry a config whose
    // fields are all absent. Presence of the config, not its contents, is the
    // version signal.
    let message = Message {
        config: Some(TransactionConfig {
            compute_unit_limit: None,
            heap_size: None,
            loaded_accounts_data_size_limit: None,
            priority_fee: None,
        }),
        versioned: true,
        ..Default::default()
    };

    assert_eq!(message_version(&message), MessageVersion::V1);
}

#[test]
fn the_tally_counts_each_version_separately() {
    let mut tally = VersionTally::default();
    tally.record(MessageVersion::Legacy);
    tally.record(MessageVersion::V1);
    tally.record(MessageVersion::V1);

    assert_eq!(tally.legacy, 1);
    assert_eq!(tally.v0, 0);
    assert_eq!(tally.v1, 2);
    assert_eq!(tally.total(), 3);
    assert_eq!(tally.to_string(), "legacy=1 v0=0 v1=2");
}
