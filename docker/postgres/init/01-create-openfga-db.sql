-- Create the OpenFGA database alongside the miramira app database.
-- The miramira database is created by Postgres at first boot via POSTGRES_DB.
CREATE DATABASE openfga;
GRANT ALL PRIVILEGES ON DATABASE openfga TO miramira;
