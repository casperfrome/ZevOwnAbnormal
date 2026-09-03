CREATE TABLE IF NOT EXISTS lab_runs (
    id VARCHAR(64) PRIMARY KEY,
    status ENUM('ACTIVE','RESETTING','RETIRED','REBUILDING','STOPPED') NOT NULL,
    seed_count INT NOT NULL DEFAULT 0,
    savepoint_path VARCHAR(1024) NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_lab_runs_status_created (status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS generator_state (
    id TINYINT PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    running BOOLEAN NOT NULL DEFAULT FALSE,
    speed TINYINT NOT NULL DEFAULT 1,
    generated_count BIGINT NOT NULL DEFAULT 0,
    last_generated_at TIMESTAMP(3) NULL,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT chk_generator_singleton CHECK (id = 1),
    CONSTRAINT chk_generator_speed CHECK (speed IN (1, 2, 5))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stores (
    id VARCHAR(16) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(80) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    order_no VARCHAR(40) NOT NULL,
    store_id VARCHAR(16) NOT NULL,
    channel VARCHAR(16) NOT NULL,
    items JSON NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    status ENUM('CREATED','PAID','PREPARING','COMPLETED','CANCELLED') NOT NULL,
    event_time DATETIME(3) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_orders_order_no (order_no),
    INDEX idx_orders_run_event (run_id, event_time),
    INDEX idx_orders_run_store (run_id, store_id)
) ENGINE=InnoDB;

INSERT INTO stores (id, name) VALUES
    ('S001', '中关村店'), ('S002', '望京店'), ('S003', '国贸店'), ('S004', '西直门店')
ON DUPLICATE KEY UPDATE name=VALUES(name);

DELIMITER //
CREATE PROCEDURE seed_flink_food_lab()
BEGIN
    DECLARE i INT DEFAULT 1;
    DECLARE active_run VARCHAR(64);
    SELECT id INTO active_run FROM lab_runs ORDER BY created_at DESC LIMIT 1;
    IF active_run IS NULL THEN
        SET active_run = 'run-seed-20260903';
        INSERT INTO lab_runs (id, status, seed_count) VALUES (active_run, 'ACTIVE', 150);
        WHILE i <= 150 DO
            INSERT INTO orders (id, run_id, order_no, store_id, channel, items, amount, status, event_time)
            VALUES (
                CONCAT(active_run, '-seed-', LPAD(i, 4, '0')),
                active_run,
                CONCAT('SEED-', LPAD(i, 6, '0')),
                CONCAT('S00', MOD(i - 1, 4) + 1),
                ELT(MOD(i - 1, 3) + 1, '堂食', '外卖', '小程序'),
                JSON_ARRAY(JSON_OBJECT('name', ELT(MOD(i - 1, 4) + 1, '经典牛肉堡', '香辣鸡腿堡', '薯条', '鸡块'), 'quantity', MOD(i, 2) + 1, 'price', 18 + MOD(i, 17))),
                (18 + MOD(i, 17)) * (MOD(i, 2) + 1),
                ELT(MOD(i - 1, 3) + 1, 'CREATED', 'PAID', 'COMPLETED'),
                TIMESTAMP('2026-09-03 09:00:00.000') + INTERVAL (i * 8) SECOND
            );
            SET i = i + 1;
        END WHILE;
    END IF;
    INSERT INTO generator_state (id, run_id, running, speed, generated_count)
    VALUES (1, active_run, FALSE, 1, 0)
    ON DUPLICATE KEY UPDATE id=VALUES(id);
END//
DELIMITER ;

CALL seed_flink_food_lab();
DROP PROCEDURE seed_flink_food_lab;

-- Older runs of the idempotent initializer may have used the mysql client's
-- latin1 default and double-encoded the deterministic Chinese seed labels.
-- Re-applying the canonical expressions is safe and makes an existing volume
-- converge to the same UTF-8 seed dataset as a fresh volume.
UPDATE orders
SET channel = ELT(MOD(CAST(RIGHT(id, 4) AS UNSIGNED) - 1, 3) + 1, '堂食', '外卖', '小程序'),
    items = JSON_ARRAY(JSON_OBJECT(
        'name', ELT(MOD(CAST(RIGHT(id, 4) AS UNSIGNED) - 1, 4) + 1, '经典牛肉堡', '香辣鸡腿堡', '薯条', '鸡块'),
        'quantity', MOD(CAST(RIGHT(id, 4) AS UNSIGNED), 2) + 1,
        'price', 18 + MOD(CAST(RIGHT(id, 4) AS UNSIGNED), 17)
    ))
WHERE order_no LIKE 'SEED-%';
