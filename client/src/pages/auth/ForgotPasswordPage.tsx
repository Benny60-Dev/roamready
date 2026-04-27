import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { authApi } from '../../services/api'
import logoIcon from '../../assets/logo-icon.png'

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const { register, handleSubmit } = useForm<{ email: string }>()

  async function onSubmit({ email }: { email: string }) {
    setLoading(true)
    await authApi.forgotPassword(email)
    setSent(true)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-rr-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-6">
            <img src={logoIcon} alt="RoamReady" className="h-16 w-auto object-contain mx-auto" />
          </Link>
          <h1 className="text-xl font-medium text-gray-900">Reset password</h1>
        </div>
        <div className="card-lg">
          {sent ? (
            <div className="text-center py-4">
              <div className="text-3xl mb-3">📧</div>
              <p className="font-medium text-gray-900 mb-1">Check your email</p>
              <p className="text-sm text-gray-500">If that account exists, we sent a reset link.</p>
              <Link to="/login" className="btn-primary inline-block mt-4">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <p className="text-sm text-gray-500">Enter your email and we'll send a reset link.</p>
              <div>
                <label className="label">Email</label>
                <input type="email" className="input" {...register('email', { required: true })} />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>
        <p className="text-center text-sm text-gray-500 mt-4">
          <Link to="/login" className="text-[#1F6F8B]">Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
