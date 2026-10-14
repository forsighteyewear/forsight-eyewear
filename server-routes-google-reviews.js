/**
 * Google Places Reviews route — fetches real recent Google reviews server-side
 * (so the API key stays secret) and caches them for 6 hours to stay within quota.
 *
 * Required env vars (set in Render):
 *   GOOGLE_PLACES_API_KEY  — Google Cloud API key with Places API enabled
 *   GOOGLE_PLACE_ID        — the Place ID for your business (from Google Maps)
 */
let reviewsCache = null; // { data, fetchedAt }

export function registerGoogleReviewsRoute(app) {
  app.get('/api/google-reviews', async (req, res) => {
    try {
      const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
      const FORSIGHT_PLACE_ID = process.env.GOOGLE_PLACE_ID;

      // Cache for 6 hours to stay within free quota
      if (
        reviewsCache &&
        Date.now() - reviewsCache.fetchedAt < 6 * 60 * 60 * 1000
      ) {
        return res.json({ ...reviewsCache.data, cached: true });
      }

      if (
        !GOOGLE_PLACES_API_KEY ||
        !FORSIGHT_PLACE_ID ||
        FORSIGHT_PLACE_ID.startsWith('ChIJxxxx')
      ) {
        return res.status(503).json({
          message:
            'Google Places API not configured. Set GOOGLE_PLACES_API_KEY and GOOGLE_PLACE_ID in Render env vars.',
          configured: false,
        });
      }

      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${FORSIGHT_PLACE_ID}&fields=reviews,rating,user_ratings_total,name&key=${GOOGLE_PLACES_API_KEY}`;
      const gRes = await fetch(url);
      const gData = await gRes.json();

      if (gData.status !== 'OK') {
        throw new Error(
          gData.error_message ||
            gData.status ||
            'Google Places request failed',
        );
      }

      const result = gData.result || {};
      const reviews = (result.reviews || [])
        .filter((r) => r.rating && r.text)
        .sort((a, b) => (b.time || 0) - (a.time || 0))
        .slice(0, 12)
        .map((r) => ({
          name: r.author_name || 'Google User',
          photo: r.profile_photo_url || null,
          rating: r.rating,
          date: r.relative_time_description || '',
          time: r.time || null,
          review: r.text,
        }));

      const payload = {
        reviews,
        rating: result.rating || null,
        total: result.user_ratings_total || null,
        name: result.name || 'Forsight Eyewear',
        configured: true,
      };

      reviewsCache = { data: payload, fetchedAt: Date.now() };
      res.json({ ...payload, cached: false });
    } catch (error) {
      console.error('Google Reviews Error:', error.message);
      res
        .status(500)
        .json({ message: error.message, configured: !!process.env.GOOGLE_PLACES_API_KEY });
    }
  });
}
