-- Finds values the built-in demo document reader may have charted into real patients through
-- "Read a prescription or report with AI" when the AI read failed (fixed in PR #13).
-- Read-only. Run against the live database, e.g.:
--   sqlite3 -header -column data/clinic.db < scripts/find-demo-reader-values.sql
-- The demo reader always returns the same fixed values, so a match is a strong sign, not proof:
-- check each hit against the patient's actual report before deleting anything.

-- 1) Lab values entered by the AI reader that match the demo lab report exactly.
SELECT 'lab' AS kind, l.id, l.patient_id, p.name AS patient, l.marker, l.value,
       datetime(l.taken_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS taken_ist,
       u.name AS entered_by
  FROM labs l
  JOIN patients p ON p.id = l.patient_id
  LEFT JOIN users u ON u.id = l.entered_by
 WHERE l.source = 'ocr'
   AND ((l.marker = 'creatinine' AND l.value = 3.01) OR (l.marker = 'urea'      AND l.value = 96)
     OR (l.marker = 'potassium'  AND l.value = 4.9)  OR (l.marker = 'sodium'    AND l.value = 138)
     OR (l.marker = 'uric_acid'  AND l.value = 5.8)  OR (l.marker = 'egfr'      AND l.value = 21)
     OR (l.marker = 'ntprobnp'   AND l.value = 2102))
 ORDER BY l.patient_id, l.taken_at;

-- 2) Vitals from the AI reader that match the demo prescription or vitals diary.
SELECT 'vital' AS kind, o.id, o.patient_id, p.name AS patient, o.type, o.v1, o.v2,
       datetime(o.observed_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS observed_ist
  FROM observations o
  JOIN patients p ON p.id = o.patient_id
 WHERE o.parser = 'gemini_vision_ocr'
   AND ((o.type = 'glucose' AND o.v1 IN (64, 104)) OR (o.type = 'weight' AND o.v1 = 59.3)
     OR (o.type = 'bp' AND o.v1 = 124 AND o.v2 = 66) OR (o.type = 'hr' AND o.v1 = 72))
 ORDER BY o.patient_id, o.observed_at;

-- 3) Medicine changes from the AI reader that match the demo documents.
SELECT 'med_change' AS kind, m.id, m.patient_id, p.name AS patient, m.med_name, m.change, m.detail, m.status,
       datetime(m.at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS at_ist
  FROM med_changes m
  JOIN patients p ON p.id = m.patient_id
 WHERE m.source = 'ocr'
   AND m.med_name IN ('Prizide MR (gliclazide)', 'Eliquis, Lasix, Concor, Prizide')
 ORDER BY m.patient_id, m.at;

-- 4) For context: every value the AI reader has ever charted, per patient and day. A batch here with
--    no matching report in the patient's Documents is worth a look even if it didn't match above.
SELECT l.patient_id, p.name AS patient, date(l.taken_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS day_ist,
       COUNT(*) AS values_charted, GROUP_CONCAT(l.marker || ' ' || l.value, ', ') AS values_
  FROM labs l
  JOIN patients p ON p.id = l.patient_id
 WHERE l.source = 'ocr'
 GROUP BY l.patient_id, day_ist
 ORDER BY day_ist DESC;
