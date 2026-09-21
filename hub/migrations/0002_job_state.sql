-- 仕事の進み（段階ごとの保存）と、取りかかり中の期限。Worker が途中で切られても続きから再開できるように
ALTER TABLE jobs ADD COLUMN state TEXT;
ALTER TABLE jobs ADD COLUMN lease_until INTEGER;
