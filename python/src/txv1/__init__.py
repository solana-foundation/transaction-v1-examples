"""Shared helpers for the transaction v1 (SIMD-0385) examples.

v1 moves the compute budget out of ComputeBudget program instructions and into
a ``TransactionConfig`` on the message. The helpers here cover the two things
that are easy to get wrong: identifying a v1 message, and reading its config.
"""
