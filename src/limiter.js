async function rpc(env, method, params) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName('global'))
  const response = await stub.fetch('https://do/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params })
  })
  if (response.status < 200 || response.status >= 300) {
    const text = await response.text()
    throw new Error(`Limiter ${method} failed (${response.status}): ${text}`)
  }
  return response.json()
}

export async function acquire(env, params) {
  return rpc(env, 'acquire', params)
}

export async function settle(env, params) {
  return rpc(env, 'settle', params)
}

export async function status(env, params) {
  return rpc(env, 'status', params)
}

export async function reset(env, params) {
  return rpc(env, 'reset', params)
}

export async function keyIps(env, params) {
  return rpc(env, 'keyIps', params)
}
