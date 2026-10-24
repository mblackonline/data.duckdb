// Synthetic public-shaped values, including cases that a single valid row misses.
module.exports = `CREATE TABLE data.gtfsrt_trip_updates_v1 AS
  SELECT '1' AS service_id, '04' AS route_id, trip_id, 0::BIGINT AS direction_id,
    'Downtown' AS stop_headsign, '19:30:00' AS trip_start_time, 101::BIGINT AS stop_id,
    101::BIGINT AS stop_code, 'Market Street' AS stop_name, 1::BIGINT AS stop_sequence,
    1::BIGINT AS stop_sequence_actual, 'SCHEDULED' AS schedule_relationship,
    'bus-1' AS vehicle_id, scheduled_arrival_time, scheduled_arrival_time AS scheduled_departure_time,
    predicted_arrival_time, predicted_departure_time, 35.04 AS latitude, -85.30 AS longitude
  FROM (VALUES
    ('normal', '19:35:57', '2026-08-18T19:51:00-04:00', '2026-08-18T19:53:00-04:00'),
    ('same_instant', '19:35:57', '2026-08-18T19:51:00-04:00', '2026-08-18T23:51:00Z'),
    ('midnight', '23:55:00', '2026-08-18T23:59:00-04:00', '2026-08-19T00:02:00-04:00'),
    ('fractional', '19:35:57', '2026-08-18T19:51:00-04:00', '2026-08-18T19:52:30-04:00'),
    ('invalid', 'bad clock', 'not a timestamp', '2026-08-18T19:53:00-04:00'),
    ('missing', NULL, NULL, '2026-08-18T19:53:00-04:00'),
    ('extended_clock', '25:10:00', '2026-08-19T01:15:00-04:00', '2026-08-19T01:17:00-04:00'),
    ('dst_fallback', '01:55:00', '2026-11-01T01:55:00-04:00', '2026-11-01T01:05:00-05:00'),
    ('negative', '19:35:57', '2026-08-18T19:51:00-04:00', '2026-08-18T19:50:00-04:00')
  ) t(trip_id, scheduled_arrival_time, predicted_arrival_time, predicted_departure_time)`;
