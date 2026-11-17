-- One search, every way. For parallel replicas:
-- SET enable_parallel_replicas = 1, max_parallel_replicas = 3, cluster_for_parallel_replicas = 'default';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'f32', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.f32 ORDER BY cosineDistance(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8})) LIMIT 10)
SETTINGS log_comment = 'f32';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'bf16', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.bf16 ORDER BY cosineDistance(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8})) LIMIT 10)
SETTINGS log_comment = 'bf16';

-- QBit: the last argument is bits per number
INSERT INTO qbit.answers (kind, q, ids) SELECT 'qbit 16 bits', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.qb ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 16) LIMIT 10)
SETTINGS log_comment = 'qbit 16 bits';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'qbit 8 bits', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.qb ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 8) LIMIT 10)
SETTINGS log_comment = 'qbit 8 bits';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'qbit 4 bits', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.qb ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 4) LIMIT 10)
SETTINGS log_comment = 'qbit 4 bits';

-- in FROM, not IN, so parallel replicas split it
INSERT INTO qbit.answers (kind, q, ids) SELECT 'qbit 8 bits, top 100 at 16', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM
    (SELECT id, v FROM qbit.qb ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 8) LIMIT 100)
 ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 16) LIMIT 10)
SETTINGS log_comment = 'qbit 8 bits, top 100 at 16';

-- strides: the fourth argument is dims
INSERT INTO qbit.answers (kind, q, ids) SELECT 'strides 1024 dims, 16 bits', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.qbs ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 16, 1024) LIMIT 10)
SETTINGS log_comment = 'strides 1024 dims, 16 bits';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'strides 1024 dims, 8 bits', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM qbit.qbs ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 8, 1024) LIMIT 10)
SETTINGS log_comment = 'strides 1024 dims, 8 bits';

INSERT INTO qbit.answers (kind, q, ids) SELECT 'strides 1024 dims 8 bits, top 100 at 16', {q:UInt8}, groupArray(id) FROM
(SELECT id FROM
    (SELECT id, v FROM qbit.qbs ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 8, 1024) LIMIT 100)
 ORDER BY cosineDistanceTransposed(v, (SELECT v FROM qbit.queries WHERE q = {q:UInt8}), 16) LIMIT 10)
SETTINGS log_comment = 'strides 1024 dims 8 bits, top 100 at 16';
