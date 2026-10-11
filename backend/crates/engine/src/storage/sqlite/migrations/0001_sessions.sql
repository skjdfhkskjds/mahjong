CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload))
);

-- A revision retains exactly the private snapshot accepted at that boundary.
CREATE TABLE session_revisions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    PRIMARY KEY (session_id, revision)
);
