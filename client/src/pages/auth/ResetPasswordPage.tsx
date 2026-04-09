import { Link, useParams, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { authApi } from '../../services/api'

export default function ResetPasswordPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { register, handleSubmit, watch } = useForm<{ password: string; confirm: string }>()

  async function onSubmit({ password }: { password: string; confirm: string }) {
    setLoading(true)
    setError('')
    try {
      await authApi.resetPassword(token!, password)
      navigate('/login?reset=true')
    } catch {
      setError('Invalid or expired reset link')
    } finally {
      setLoading(false)
    }
  }

  const password = watch('password')

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 bg-[#1D9E75] rounded-lg flex items-center justify-center">
              <span className="text-white text-sm font-medium">RR</span>
            </div>
          </Link>
          <h1 className="text-xl font-medium text-gray-900">Set new password</h1>
        </div>
        <div className="card-lg">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && <div className="bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">{error}</div>}
            <div>
              <label className="label">New password</label>
              <input type="password" className="input" {...register('password', { required: true, minLength: 8 })} />
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
