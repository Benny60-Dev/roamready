import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { authApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import logoIcon from '../../assets/logo-icon.png'

interface FormData {
  firstName: string
  lastName: string
  email: string
  password: string
}

export default function SignupPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setUser, setToken } = useAuthStore()
  const navigate = useNavigate()
  const { register, handleSubmit, formState: { errors } } = useForm<FormData>()

  async function onSubmit(data: FormData) {
    setLoading(true)
    setError('')
    try {
      const res = await authApi.register(data)
      setToken(res.data.accessToken)
      setUser(res.data.user)
      navigate('/onboarding')
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to create account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block mb-6">
            <img src={logoIcon} alt="RoamReady" className="h-16 w-auto object-contain mx-auto" />
          </Link>
          <h1 className="text-xl font-medium text-gray-900">Create your account</h1>
          <p className="text-sm text-gray-500 mt-1">Start your 7-day free trial</p>
        </div>

        <div className="card-lg">
          <a
            href="/api/v1/auth/google"
            className="flex items-center justify-center gap-3 w-full border border-gray-200 rounded-lg py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors mb-4"
            style={{ borderWidth: '0.5px' }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </a>

          <div className="flex items-center gap-3 mb-4">
            <hr className="flex-1" style={{ borderWidth: '0.5px' }} />
            <span className="text-xs text-gray-400">or</span>
            <hr className="flex-1" style={{ borderWidth: '0.5px' }} />
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">First name</label>
                <input className="input" {...register('firstName', { required: true })} />
                {errors.firstName && <p className="text-xs text-red-500 mt-1">Required</p>}
              </div>
              <div>
                <label className="label">Last name</label>
                <input className="input" {...register('lastName', { required: true })} />
              </div>
            </div>
            <div>
              <label className="label">Email</label>
              <input type="email" className="input" {...register('email', { required: true })} />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" className="input" {...register('password', { required: true, minLength: 8 })} />
              {errors.password && <p className="text-xs text-red-500 mt-1">At least 8 characters</p>}
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>
          <p className="text-xs text-center text-gray-400 mt-3">
            By creating an account, you agree to our{' '}
            <Link to="/terms" className="text-[#1E3A8A] hover:underline">Terms of Service</Link>{' '}
            and{' '}
            <Link to="/privacy" className="text-[#1E3A8A] hover:underline">Privacy Policy</Link>
          </p>
        </div>

        <p className="text-center text-sm text-gray-500 mt-4">
          Already have an account?{' '}
          <Link to="/login" className="text-[#1E3A8A] font-medium">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
