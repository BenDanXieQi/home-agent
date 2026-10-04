-- Custom SQL migration file, put your code below! --
UPDATE "context_records"
SET "certainty" = CASE
      WHEN "certainty" <> 'conflicting' AND "data"->>'state' = 'confirmed'
        THEN 'supported'::context_certainty
      ELSE "certainty"
    END,
    "summary" = CASE
      WHEN "certainty" <> 'conflicting' AND "data"->>'state' = 'confirmed'
        THEN replace(replace("summary", '，身份尚待确认。', '。'), '可能观察到', '观察到')
      ELSE replace("summary", '，身份尚待确认。', '。')
    END,
    "data" = "data" - 'reviewed'
WHERE "topic" = 'member_sighting' AND "data" ? 'reviewed';
