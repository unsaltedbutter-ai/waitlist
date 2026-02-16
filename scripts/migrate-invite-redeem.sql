-- Migration: Add redeemed_at column to waitlist table
-- Prevents invite codes from being reused after signup
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ DEFAULT NULL;
