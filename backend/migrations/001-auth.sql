-- Explicit operator-run migration only. The migration runner must first inspect
-- existing DDL and refuse incompatible schemas. Never ALTER/DROP existing users.
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(20) NOT NULL PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    birthday DATE NOT NULL,
    email VARCHAR(254) NOT NULL,
    name VARCHAR(50) NOT NULL,
    account_active BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    account_locked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The schema guard requires compatible users.id collation. No FK is added to
-- the existing table. Transactions enforce ownership and token/session lifetime.
CREATE TABLE IF NOT EXISTS auth_pending_registrations (
    user_id VARCHAR(20) NOT NULL PRIMARY KEY,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    KEY auth_sessions_user (user_id),
    KEY auth_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    purpose ENUM('verify', 'reset') NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    KEY auth_tokens_user_purpose (user_id, purpose),
    KEY auth_tokens_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    hits INT UNSIGNED NOT NULL,
    reset_at DATETIME(3) NOT NULL,
    KEY auth_rate_limits_reset (reset_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_mail_outbox (
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    payload TEXT NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(3) NOT NULL,
    lease_until DATETIME(3) NULL,
    claim_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY auth_mail_outbox_available (available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
