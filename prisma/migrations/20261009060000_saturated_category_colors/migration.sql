-- Reemplaza los colores pastel por defecto por colores normales (solo si el usuario no los personalizó)
UPDATE "categories" SET "colorHex"='#2F80ED' WHERE "name"='Yape / Plin' AND upper("colorHex")='#B7D4EF';
UPDATE "categories" SET "colorHex"='#F57C00' WHERE "name"='Alimentación' AND upper("colorHex")='#F5CBA3';
UPDATE "categories" SET "colorHex"='#8E44AD' WHERE "name"='Servicios y utilities' AND upper("colorHex")='#D6C9EE';
UPDATE "categories" SET "colorHex"='#607D8B' WHERE "name"='Otros comercios' AND upper("colorHex")='#D9D6CE';
UPDATE "categories" SET "colorHex"='#3F51B5' WHERE "name"='Transporte' AND upper("colorHex")='#C7CBF0';
UPDATE "categories" SET "colorHex"='#E91E63' WHERE "name"='Salud' AND upper("colorHex")='#F3C6D9';
UPDATE "categories" SET "colorHex"='#795548' WHERE "name"='Movimientos financieros' AND upper("colorHex")='#DDD5CB';
UPDATE "categories" SET "colorHex"='#2E9E5B' WHERE "name"='Ingresos' AND upper("colorHex")='#BFE3C9';
UPDATE "categories" SET "colorHex"='#78909C' WHERE "name"='No considerar' AND upper("colorHex")='#C9D3E0';
