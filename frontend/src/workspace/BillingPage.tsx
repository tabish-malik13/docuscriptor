import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, CreditCard, FileStack, HardDrive, Layers, RefreshCw } from 'lucide-react'
import { useTenantApi } from './TenantContext'
import './billing.css'

type Plan = 'plus' | 'ultimate'
type Provider = 'stripe' | 'razorpay'
type Capacity = { storageBytes: number; savedTemplates: number; retainedJobs: number }
type Purchase = { provider: Provider; plan: Plan }
type Billing = {
  mode: 'self-hosted' | 'managed'
  plan: 'self-hosted' | 'starter' | Plan
  source: 'self-hosted' | 'included' | 'contract' | 'subscription'
  limits: Capacity
  usage: Capacity
  plans: { id: Plan; name: string; limits: Capacity }[]
  providers: Record<Provider, boolean>
  canCheckout: boolean
  pending: Purchase | null
  subscription: (Purchase & { status: 'active' | 'pending' | 'past_due' | 'canceled' | 'expired'; periodEnd: string | null }) | null
}

const planNames = { 'self-hosted': 'Self-hosted', starter: 'Starter', plus: 'Plus', ultimate: 'Ultimate' }
const sources = { 'self-hosted': 'Managed by your deployment', included: 'Included with this workspace', contract: 'Contract license', subscription: 'Subscription license' }
const providerNames = { stripe: 'Stripe', razorpay: 'Razorpay' }
const providers: Provider[] = ['stripe', 'razorpay']
const statuses = { active: 'Active', pending: 'Pending', past_due: 'Payment past due', canceled: 'Canceled', expired: 'Renewal unconfirmed' }
const capacities = [
  { key: 'storageBytes', label: 'Storage', icon: HardDrive },
  { key: 'savedTemplates', label: 'Saved templates', icon: Layers },
  { key: 'retainedJobs', label: 'Retained jobs', icon: FileStack },
] as const
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function displayCapacity(key: keyof Capacity, value: number) {
  if (key !== 'storageBytes') return numberFormat.format(value)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0
  return numberFormat.format(value / 1024 ** unit) + ' ' + units[unit]
}

export function BillingPage() {
  const { api, tenant } = useTenantApi()
  const [billing, setBilling] = useState<Billing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'checkout' | 'refresh' | null>(null)
  const [retry, setRetry] = useState(0)
  const [planChoice, setPlanChoice] = useState<Plan>('plus')
  const [providerChoice, setProviderChoice] = useState<Provider>('stripe')
  const operation = useRef<AbortController | null>(null)
  const version = useRef(0)

  useEffect(() => {
    if (operation.current) return
    const controller = new AbortController()
    const current = ++version.current
    setError('')
    api('/api/billing', { signal: controller.signal }).then(response => response.json()).then((result: Billing) => {
      if (!controller.signal.aborted && current === version.current && !operation.current) setBilling(result)
    }).catch(cause => {
      if (!controller.signal.aborted && current === version.current && !operation.current) setError(cause instanceof Error ? cause.message : 'Billing details could not be loaded.')
    })
    return () => controller.abort()
  }, [api, retry])

  useEffect(() => () => operation.current?.abort(), [])

  async function act(action: 'refresh' | 'checkout', purchase?: Purchase) {
    if (operation.current || !billing) return
    const controller = new AbortController()
    version.current++
    operation.current = controller
    setBusy(action); setError('')
    try {
      const response = await api('/api/billing/' + action, {
        method: 'POST', signal: controller.signal, body: JSON.stringify(purchase ?? {}),
      })
      if (action === 'refresh') {
        const result: Billing = await response.json()
        if (!controller.signal.aborted) setBilling(result)
      } else {
        const result: { url: string } = await response.json()
        const url = new URL(result.url)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The checkout link is unavailable. Try again.')
        if (!controller.signal.aborted) window.location.assign(url.href)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'The billing request could not be completed.')
        // A lost checkout response can still leave a pending attempt on the server.
        if (action === 'checkout') {
          try {
            const result: Billing = await (await api('/api/billing', { signal: controller.signal })).json()
            if (!controller.signal.aborted) setBilling(result)
          } catch { /* The original checkout error is already visible. */ }
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null)
      if (operation.current === controller) operation.current = null
    }
  }

  if (!billing) return error ? <div className="error-box" role="alert">{error} <button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
    : <p role="status" className="form-note">Loading billing details…</p>

  const available = providers.filter(id => billing.providers[id])
  const provider = billing.pending?.provider ?? (available.includes(providerChoice) ? providerChoice : available[0])
  const plan = billing.pending?.plan ?? planChoice
  const canSelect = billing.canCheckout && !billing.pending
  const canContinue = billing.canCheckout && provider && billing.providers[provider] && !busy
  const latest = billing.subscription
  const statusProvider = billing.pending?.provider ?? (latest && latest.status !== 'canceled' ? latest.provider : null)
  const providerUnavailable = statusProvider && !billing.providers[statusProvider]
  return <div className="billing-page" aria-busy={!!busy}>
    <section aria-labelledby="license-heading" className="panel billing-license">
      <div className="billing-license-header">
        <div><h2 id="license-heading">Current license</h2><p className="billing-license-name">{planNames[billing.plan]}</p><p className="billing-source">{sources[billing.source]} · {tenant.name}</p></div>
        {latest && <div className="billing-subscription"><strong>{providerNames[latest.provider]} · {statuses[latest.status]}</strong>
          {latest.periodEnd && <span>{latest.status === 'expired' ? 'Paid period ended ' : 'Period end · '}{dateFormat.format(new Date(latest.periodEnd))}</span>}</div>}
      </div>
      <dl className="billing-usage">{capacities.map(({ key, label }) => <div key={key}>
        <dt>{label}</dt><dd><strong>{displayCapacity(key, billing.usage[key])}</strong> of {displayCapacity(key, billing.limits[key])}</dd>
        <progress aria-label={label + ' used'} value={Math.min(billing.usage[key], billing.limits[key])} max={billing.limits[key]} />
      </div>)}</dl>
    </section>
    <fieldset className="billing-plan-group"><legend>Compare plans</legend><div className="billing-plans">
      {billing.plans.map(item => <label className={'panel billing-plan' + (canSelect && item.id === plan ? ' billing-selected' : '')} key={item.id}>
        <span className="billing-plan-heading"><strong>{item.name}</strong>{billing.plan === item.id && <span className="billing-current"><Check size={14} />Current plan</span>}
          {billing.canCheckout && !billing.pending && <input type="radio" name="billing-plan" value={item.id} aria-label={'Choose ' + item.name}
            checked={plan === item.id} disabled={!!busy} onChange={() => setPlanChoice(item.id)} />}</span>
        <span className="billing-allowances">{capacities.map(({ key, label, icon: Icon }) => <span key={key}><Icon size={16} aria-hidden="true" />{displayCapacity(key, item.limits[key])} {label.toLowerCase()}</span>)}</span>
      </label>)}
    </div></fieldset>
    <section aria-labelledby="payment-heading" className="panel billing-payment">
      <div className="billing-payment-title"><CreditCard size={19} aria-hidden="true" /><h2 id="payment-heading">Payment</h2></div>
      <p className="billing-payment-note">{providerUnavailable ? 'Ask your deployment administrator to reconnect ' + providerNames[statusProvider] + ' to check the status of your existing ' + (billing.pending ? 'checkout.' : 'subscription.')
        : billing.pending ? 'A ' + planNames[plan] + ' checkout with ' + providerNames[billing.pending.provider] + ' is pending. Check its status after payment.'
        : billing.source === 'contract' ? 'Your organization has a contract license. Contact your account administrator for billing changes.'
        : billing.mode === 'self-hosted' ? 'Checkout with Stripe or Razorpay is disabled for this self-hosted workspace.'
        : latest?.status === 'expired' ? 'Check payment status to see whether ' + providerNames[latest.provider] + ' has confirmed your renewal.'
        : !available.length ? 'Your deployment administrator can enable checkout by connecting Stripe or Razorpay.'
        : !billing.canCheckout && latest ? 'Your subscription is managed through ' + providerNames[latest.provider] + '.'
        : 'Review the recurring price, currency and billing schedule at checkout before paying.'}</p>
      <div className="billing-payment-controls">
        {canSelect && available.length > 0 && <label className="field billing-provider">Payment provider<select value={provider} disabled={!!busy} onChange={event => setProviderChoice(event.target.value as Provider)}>
          {available.map(id => <option key={id} value={id}>{providerNames[id]}</option>)}
        </select></label>}
        {billing.canCheckout && <button type="button" className="button primary" disabled={!canContinue} onClick={() => { if (provider) void act('checkout', { provider, plan }) }}>
          {busy === 'checkout' ? 'Opening checkout…' : billing.pending ? 'Resume checkout' : 'Continue with ' + planNames[plan]}<ArrowUpRight size={15} /></button>}
        {statusProvider && billing.providers[statusProvider] && <button type="button" className="button secondary" disabled={!!busy} onClick={() => { void act('refresh') }}><RefreshCw size={15} />{busy === 'refresh' ? 'Checking…' : 'Check payment status'}</button>}
      </div>
      {error && <div role="alert" className="error-box billing-action-error">{error}</div>}
    </section>
  </div>
}
