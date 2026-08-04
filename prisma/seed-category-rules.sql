INSERT INTO "CategoryRule" (id, keyword, "categoryId", "categoryName", "createdAt")
VALUES
  (gen_random_uuid(), 'hair dye', '31412', 'Hair Color Products', now()),
  (gen_random_uuid(), 'hair color', '31412', 'Hair Color Products', now()),
  (gen_random_uuid(), 'toys', '220', 'Toys & Hobbies', now()),
  (gen_random_uuid(), 'craft sticker', '11794', 'Craft Stickers', now()),
  (gen_random_uuid(), 'vinyl sticker', '159889', 'Decor Decals, Stickers & Vinyl Art', now())
ON CONFLICT (keyword) DO NOTHING;
