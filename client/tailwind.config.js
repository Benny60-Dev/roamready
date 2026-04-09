/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        green: {
          DEFAULT: '#1D9E75',
          light: '#E1F5EE',
          dark: '#085041',
        },
        amber: {
          DEFAULT: '#EF9F27',
        },
        coral: {
          DEFAULT: '#D85A30',
        },
        purple: {
          DEFAULT: '#7F77DD',
        },
        blue: {
          DEFAULT: '#378ADD',
        },
        red: {
          DEFAULT: '#E24B4A',
        },
        gray: {
          DEFAULT: '#888780',
        },
        brand: {
          green: '#1D9E75',
          'green-light': '#E1F5EE',
          'green-dark': '#085041',
          amber: '#EF9F27',
          coral: '#D85A30',
          purple: '#7F77DD',
          blue: '#378ADD',
          red: '#E24B4A',
          gray: '#888780',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      fontWeight: {
        normal: '400',
        medium: '500',
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
    },
  },
  plugins: [],
}
