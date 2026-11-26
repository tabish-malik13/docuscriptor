export function stripeCheckoutReturn(url: URL) {
  const values = url.searchParams.getAll('stripe_checkout')
  if (url.hash !== '#billing' || values.length !== 1) return null
  return values[0] === 'success' || values[0] === 'cancel' ? values[0] : null
}
