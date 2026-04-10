import { Link } from 'react-router-dom'
import { ChevronRight, ArrowLeft } from 'lucide-react'

export interface BreadcrumbItem {
  label: string
  href?: string
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null

  const parent = items.length >= 2 ? items[items.length - 2] : null

  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      {/* Desktop: full chain */}
      <ol className="hidden sm:flex items-center flex-wrap">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={i} className="flex items-center">
              {i > 0 && (
                <ChevronRight size={13} className="mx-1.5 text-gray-300 flex-shrink-0" />
              )}
              {!isLast && item.href ? (
                <Link
                  to={item.href}
                  className="text-xs text-[#1D9E75] hover:text-[#178a65] transition-colors"
                >
                  {item.label}
                </Link>
              ) : (
                <span className={`text-xs ${isLast ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      {/* Mobile: back arrow to immediate parent only */}
      {parent && (
        <div className="flex sm:hidden">
          {parent.href ? (
            <Link
              to={parent.href}
              className="flex items-center gap-1 text-xs text-[#1D9E75] hover:text-[#178a65] transition-colors"
            >
              <ArrowLeft size={13} />
              {parent.label}
            </Link>
          ) : (
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <ArrowLeft size={13} />
              {parent.label}
            </span>
          )}
        </div>
      )}
    </nav>
  )
}
