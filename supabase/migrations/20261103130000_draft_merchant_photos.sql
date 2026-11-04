-- Applied 20261103130000 · draft_merchant_photos
--
-- Photos for the draft merchants, taken from each merchant's own website and
-- copied to media/providers/<slug>/. They still belong to the merchant: get a
-- yes from each one before any of these providers goes live. gallery[0] is also
-- the plan card's picture. Every update is guarded on status = 'inactive', so
-- this can never rewrite a provider that has since launched.
--
-- Left without pictures on purpose: Palapa Pool Bar (two possible venues, not
-- yet settled) and CC Print (its site has only stock and a client's poster).
-- Also corrects what the sites showed the first drafts had wrong or missing.

do $$
declare base text := 'https://igbytraidldkhhamsfdo.supabase.co/storage/v1/object/public/media/providers/';
begin
  update public.providers set banner_url = base || 'roatan-yacht-club/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'roatan-yacht-club/gallery-1.jpg', base || 'roatan-yacht-club/gallery-2.jpg', base || 'roatan-yacht-club/gallery-3.jpg', base || 'roatan-yacht-club/gallery-4.jpg'),
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000b2' and status = 'inactive';

  update public.providers set banner_url = base || 'clearwater-adventures/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'clearwater-adventures/gallery-1.jpg', base || 'clearwater-adventures/gallery-2.jpg', base || 'clearwater-adventures/gallery-3.jpg', base || 'clearwater-adventures/gallery-4.jpg'),
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000ba' and status = 'inactive';

  update public.providers set banner_url = base || 'scuba-shop/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'scuba-shop/gallery-1.jpg', base || 'scuba-shop/gallery-2.jpg', base || 'scuba-shop/gallery-3.jpg', base || 'scuba-shop/gallery-4.jpg'),
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000b4' and status = 'inactive';

  update public.providers set banner_url = base || 'spirit-origin-coffee/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'spirit-origin-coffee/gallery-1.jpg', base || 'spirit-origin-coffee/gallery-2.jpg', base || 'spirit-origin-coffee/gallery-3.jpg', base || 'spirit-origin-coffee/gallery-4.jpg'),
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000bf' and status = 'inactive';

  update public.providers set banner_url = base || 'roatan-island-brewing/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'roatan-island-brewing/gallery-1.jpg', base || 'roatan-island-brewing/gallery-2.jpg', base || 'roatan-island-brewing/gallery-3.jpg', base || 'roatan-island-brewing/gallery-4.jpg'),
    description = 'A Caribbean craft brewery in the jungle of Roatán, delivered to your door every month or in bulk for an event.',
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000b7' and status = 'inactive';

  update public.providers set banner_url = base || 'petes-place/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'petes-place/gallery-1.jpg', base || 'petes-place/gallery-2.jpg'),
    description = 'The clubhouse and driving range of The Black Pearl at The Club Roatán. A monthly plan for people who play regularly.',
    location = 'The Club Roatán, St. John''s Bay',
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000b5' and status = 'inactive';

  update public.providers set banner_url = base || 'roatan-provision/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'roatan-provision/banner.jpg'),
    location = 'Coxen Hole, Roatán',
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000be' and status = 'inactive';

  update public.providers set banner_url = base || 'roatan-fruit-dealer/banner.jpg',
    gallery_urls = jsonb_build_array(base || 'roatan-fruit-dealer/gallery-1.jpg'),
    location = 'Roatán',
    contact_phone = '+504 8730-7603',
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000bd' and status = 'inactive';

  update public.providers set banner_url = base || 'bifat/banner.jpg',
    description = 'Bay Islands Fitness and Transformation Center. Draft placeholder: no offer until the clinic says what it can provide to existing clients. All clinical and refill decisions stay with the clinic.',
    location = 'French Harbour, Roatán',
    updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000b3' and status = 'inactive';

  update public.providers set location = 'Plaza Mango Tree Center, Roatán', updated_at = now()
  where id = '5a1e0000-0000-4000-8000-0000000000bb' and status = 'inactive';
end $$;
