#!/usr/bin/env bash
# Setup PostgreSQL 16 on Linux LAN box and apply schema
set -euo pipefail

# -----------------------------------------------------------
# This script is meant to be run ON the Linux box, not remotely.
# Copy it there: scp scripts/setup-db.sh user@linux-box:~
# Then: chmod +x setup-db.sh && sudo ./setup-db.sh
# -----------------------------------------------------------

DB_NAME="unsaltedbutter"
DB_USER="butter"
DB_PASS=$(openssl rand -base64 24)
LAN_SUBNET="192.168.0.0/16"  # Adjust to your LAN

echo "=== Installing PostgreSQL 16 ==="

# Add PostgreSQL APT repo if PG 16 isn't available
if ! apt-cache show postgresql-16 &>/dev/null; then
    echo "Adding PostgreSQL APT repository..."
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add -
    apt update
fi

apt install -y postgresql-16 postgresql-client-16

echo "=== Creating database and user ==="

sudo -u postgres psql <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
        CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
    END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
EOF

echo "=== Configuring LAN access ==="

PG_CONF="/etc/postgresql/16/main/postgresql.conf"
HBA_CONF="/etc/postgresql/16/main/pg_hba.conf"

# Allow listening on all interfaces
if grep -q "^#listen_addresses" "$PG_CONF"; then
    sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" "$PG_CONF"
elif grep -q "^listen_addresses" "$PG_CONF"; then
    sed -i "s/^listen_addresses.*/listen_addresses = '*'/" "$PG_CONF"
else
    echo "listen_addresses = '*'" >> "$PG_CONF"
fi

# Add LAN access rule if not present
HBA_LINE="host    ${DB_NAME}    ${DB_USER}    ${LAN_SUBNET}    scram-sha-256"
if ! grep -qF "${DB_USER}" "$HBA_CONF"; then
    echo "$HBA_LINE" >> "$HBA_CONF"
fi

echo "=== Restarting PostgreSQL ==="
systemctl restart postgresql

echo "=== Done ==="
echo ""
echo "NEXT STEPS:"
echo "1. Save the generated password (shown below). It will not be displayed again."
echo ""
echo "   Database password for '${DB_USER}': ${DB_PASS}"
echo ""
echo "2. Apply schema from your Mac: psql -h $(hostname -I | awk '{print $1}') -U ${DB_USER} -d ${DB_NAME} -f scripts/schema.sql"
echo "3. Test connection from Mac: psql -h $(hostname -I | awk '{print $1}') -U ${DB_USER} -d ${DB_NAME}"
