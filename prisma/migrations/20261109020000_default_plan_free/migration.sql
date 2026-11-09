-- Todo usuario nuevo empieza en el plan Gratis.
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'FREE';
