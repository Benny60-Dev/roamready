/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1E3A8A',
          light: '#EFF6FF',
          dark: '#1E40AF',
        },
        rr: {
          // Primary identity
          blue: {
            DEFAULT: '#1F6F8B',   // Deep RV body blue — wordmark "Roam"
            light: '#2F7BD4',     // Bright RV blue — active states
            dark: '#134756',      // Hover/pressed
            50:  '#E0F0F4',
            100: '#B8DCE5',
            700: '#134756',
            900: '#081E25',
          },
          gold: {
            DEFAULT: '#F7A829',   // Sunset gold — wordmark "Ready", CTAs
            light: '#FFC061',
            dark: '#C9851A',
            50:  '#FDEFD9',
            100: '#FADFB2',
            700: '#8A5A0E',
            900: '#3D2705',
          },
          pine: {
            DEFAULT: '#3E5540',   // Desert pine green — sampled from splash end-frame hills
            light:   '#5C7560',   // Hover / softer variant
            dark:    '#2F4030',   // Text on light pine backgrounds
            50:      '#DCE5D5',   // Pill backgrounds ("Completed" status)
            100:     '#B8C8AC',   // Pill borders
            700:     '#2F4030',   // Dark text on 50 backgrounds
            900:     '#17210D',   // Deepest tone
          },

          // Sunset gradient stops (hero moments only — splash, empty states)
          sunset: {
            purple:  '#531C8A',
            magenta: '#B21A74',
            red:     '#FC5237',
            gold:    '#F7A829',
          },

          // Warm neutrals — subtle desert tint
          bg:      '#F5F0E5',   // Warm off-white page background
          surface: '#FFFFFF',   // Cards / raised surfaces
          border:  '#E8E4DA',   // Warm-tinted borders
          muted:   '#6B6458',   // Muted/secondary text
          ink:     '#1A1A1A',   // Primary body text
        },
        accent: {
          DEFAULT: '#F7A829',
          light: '#FDEFD9',
          dark: '#C9851A',
          decorative: '#F97316',
        },
        success: {
          DEFAULT: '#0F766E',
          light: '#CCFBF1',
          dark: '#0D5F58',
        },
        premium: {
          DEFAULT: '#7E22CE',
          light: '#F5F3FF',
        },
        amber: {
          DEFAULT: '#EF9F27',
        },
        purple: {
          DEFAULT: '#7F77DD',
        },
        red: {
          DEFAULT: '#E24B4A',
        },
        gray: {
          DEFAULT: '#888780',
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
