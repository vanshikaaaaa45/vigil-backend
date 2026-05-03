-- Teams table
CREATE TABLE IF NOT EXISTS teams (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) UNIQUE,
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       VARCHAR(20) NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Team members with roles
CREATE TABLE IF NOT EXISTS team_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      VARCHAR(20) NOT NULL DEFAULT 'member'
              CHECK (role IN ('admin','member','viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE INDEX idx_team_members_team ON team_members(team_id);

-- Create a personal team for every existing user
INSERT INTO teams (name, slug, owner_id)
SELECT name, LOWER(REGEXP_REPLACE(name, '[^a-z0-9]+', '-', 'g')), id
FROM users
ON CONFLICT (slug) DO NOTHING;

-- Add each user as admin of their personal team
INSERT INTO team_members (team_id, user_id, role)
SELECT t.id, t.owner_id, 'admin'
FROM teams t
ON CONFLICT (team_id, user_id) DO NOTHING;