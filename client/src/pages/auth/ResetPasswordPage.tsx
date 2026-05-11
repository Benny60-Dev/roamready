import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { authApi } from '../../services/api'

export default function ResetPasswordPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const navigate = useNavigate()
  const { register, handleSubmit, watch, formState: { errors } } = useForm<{ password: string; confirm: string }>()

  async function onSubmit({ password }: { password: string; confirm: string }) {
    setLoading(true)
    setError('')
    try {
      await authApi.resetPassword(token!, password)
      navigate('/login?reset=true')
    } catch (e: any) {
      // Distinguish password-policy rejection (INVALID_PASSWORD) from
      // the legitimate "token expired / invalid" case. The server
      // sends a structured error code + human message for the former;
      // anything else falls through to the generic reset-link copy.
      const code = e?.response?.data?.error
      const message = e?.response?.data?.message
      if (code === 'INVALID_PASSWORD' && message) {
        setError(message)
      } else {
        setError('Invalid or expired reset link')
      }
    } finally {
      setLoading(false)
    }
  }

  const password = watch('password')

  return (
    <div className="min-h-screen bg-rr-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-6">
            <img src="/roamready-icon.png" alt="RoamReady" className="h-16 w-auto object-contain mx-auto" />
          </Link>
          <h1 className="text-xl font-medium text-gray-900">Set new password</h1>
        </div>
        <div className="card-lg">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">{error}</div>}
            <div>
              <label className="label">New password</label>
              {/* Mirrors SignupPage policy: 10-char min client-side;
                  breach-list rejection is server-side and surfaces via
                  the `error` state above. */}
              <input type="password" className="input" {...register('password', { required: true, minLength: 10 })} />
              {errors.password?.type === 'minLength' && (
                <p className="text-xs text-red-500 mt-1">Password must be at least 10 characters.</p>
              )}
              {errors.password?.type === 'required' && (
                <p className="text-xs text-red-500 mt-1">Password is required.</p>
              )}
            </div>
            <div>
              <label className="label">Confirm password</label>
              <input
                type="password"
                className="input"
                {...register('confirm', {
                  required: true,
                  validate: v => v === password || 'Passwords do not match'
                })}
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
              {loading ? 'Updating...' : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
