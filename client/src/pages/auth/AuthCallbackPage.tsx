import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { authApi } from '../../services/api'

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams()
  const { setToken, setUser } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) return navigate('/login?error=auth_failed')

    setToken(token)
    authApi.getMe()
      .then(res => {
        setUser(res.data)
        if (!res.data.rigs?.length) {
          navigate('/onboarding')
        } else {
          navigate('/dashboard')
        }
      })
      .catch(() => navigate('/login?error=auth_failed'))
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-500">Signing you in...</p>
      </div>
    </div>
  )
}
