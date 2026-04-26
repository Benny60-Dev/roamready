import { Link } from 'react-router-dom'
import logoIcon from '../assets/logo-icon.png'

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-4xl mx-auto py-12 px-6">
        <div className="mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-6">
            <img src={logoIcon} alt="RoamReady" className="h-8 w-auto object-contain" />
            <span className="font-medium">
              <span style={{ color: '#1F6F8B' }}>Roam</span><span style={{ color: '#F7A829' }}>ready</span><span style={{ color: '#1F6F8B' }}>.ai</span>
            </span>
          </Link>
          <h1 className="text-3xl font-semibold text-gray-900">Privacy Policy</h1>
          <p className="text-sm text-gray-500 mt-2">Last updated: April 19, 2026</p>
        </div>

        <div className="prose max-w-none text-gray-700 space-y-10">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Introduction</h2>
            <p>
              Martini AI Media LLC, doing business as <strong>RoamReady</strong> ("we," "us," or "our"), operates the RoamReady
              service available at roamready.ai. This Privacy Policy explains what information we collect,
              how we use it, who we share it with, and what rights you have over your data.
            </p>
            <p className="mt-3">
              By using RoamReady, you agree to the collection and use of information as described in this policy. If you do not
              agree, please do not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Information We Collect</h2>

            <h3 className="text-base font-semibold text-gray-800 mb-2">Account Information</h3>
            <p>When you create an account, we collect your name, email address, and a securely hashed version of your password. We never store your password in plain text.</p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Profile and Vehicle Information</h3>
            <p>To provide personalized trip planning, you may choose to share:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Vehicle specifications (make, model, length, height, hookup types)</li>
              <li>Pet information and home location</li>
              <li>Memberships (Good Sam, KOA, military/veteran status)</li>
              <li>Travel preferences and accessibility needs</li>
            </ul>
            <p className="mt-2">All profile information is optional and can be updated or deleted at any time.</p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Trip Data</h3>
            <p>When you use RoamReady to plan trips, we collect and store:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Destinations, dates, stops, and routes</li>
              <li>Saved trips and AI-generated itineraries</li>
              <li>Trip journal entries, including any photos and ratings you add</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Subscription and Billing Data</h3>
            <p>
              We collect your subscription tier and billing history. Payment processing is handled entirely by Stripe — we
              never store your credit card number, CVV, or full billing address. Stripe may collect and retain payment
              information subject to their own privacy policy.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Usage and Technical Data</h3>
            <p>We automatically collect certain information when you use RoamReady, including:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Pages visited and features used</li>
              <li>IP address, browser type, and device information</li>
              <li>Basic analytics to help us improve the service</li>
            </ul>
            <p className="mt-2">This data is used for security, debugging, and understanding how the service is used.</p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Google Sign-In Data</h3>
            <p>
              If you choose to sign in with Google, we receive your email address, name, and profile photo from Google.
              We do not receive your Google password or access to other Google services beyond what you explicitly authorize.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Create and manage your account</li>
              <li>Generate personalized trip itineraries and campground recommendations using AI</li>
              <li>Process subscription payments and send billing receipts</li>
              <li>Send transactional emails (password resets, account notifications)</li>
              <li>Provide customer support and respond to inquiries</li>
              <li>Improve the service through usage analytics</li>
              <li>Detect and prevent fraud or abuse</li>
              <li>Comply with legal obligations</li>
            </ul>
            <p className="mt-3">
              We do not sell your personal information. We do not use your data for behavioral advertising or share it
              with advertising networks.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">How We Share Your Information</h2>
            <p>We share data with the following third-party service providers only to the extent necessary to operate RoamReady:</p>

            <div className="mt-4 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-gray-800">Anthropic (Claude AI)</h3>
                <p className="mt-1">Your trip planning inputs (destinations, vehicle specs, preferences) are sent to Anthropic's Claude AI to generate itineraries. This data is governed by Anthropic's privacy policy. We do not send sensitive personal information beyond what is needed for trip generation.</p>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-800">Google (Maps, Places, OAuth)</h3>
                <p className="mt-1">Location and routing data is processed through Google Maps and Places APIs. If you sign in with Google, your authentication is handled by Google OAuth. Google's privacy policy governs their use of this data.</p>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-800">Stripe</h3>
                <p className="mt-1">We share your email address and subscription information with Stripe for payment processing. Stripe handles all payment card data directly and is PCI-DSS compliant. We never see or store your full card number.</p>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-800">Resend</h3>
                <p className="mt-1">We use Resend to send transactional emails such as password resets and account notifications. Your email address is shared with Resend for this purpose.</p>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-800">Open-Meteo</h3>
                <p className="mt-1">Weather forecasts are retrieved from Open-Meteo, a public weather API. No personal user data is sent to Open-Meteo.</p>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-800">Amazon Web Services (AWS)</h3>
                <p className="mt-1">Our infrastructure may be hosted on AWS. Your data is stored on their servers and is subject to appropriate data processing agreements.</p>
              </div>
            </div>

            <p className="mt-4">
              We may also disclose your information if required to do so by law, court order, or legal process, or to
              protect the rights, property, or safety of RoamReady, our users, or the public.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Your Rights</h2>
            <p>Depending on where you live, you may have the following rights regarding your personal data:</p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">For All Users</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>Access:</strong> Request a copy of the personal data we hold about you</li>
              <li><strong>Correction:</strong> Ask us to correct inaccurate information</li>
              <li><strong>Deletion:</strong> Request that we delete your account and associated data</li>
              <li><strong>Portability:</strong> Request your data in a portable format</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">California Residents (CCPA/CPRA)</h3>
            <p>If you are a California resident, you have additional rights under the California Consumer Privacy Act:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Right to know what personal information we collect and how it is used</li>
              <li>Right to delete your personal information</li>
              <li>Right to correct inaccurate personal information</li>
              <li>Right to opt-out of the sale or sharing of your personal information (we do not sell or share personal information for advertising)</li>
              <li>Right to non-discrimination for exercising your privacy rights</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Virginia, Colorado, Connecticut, and Utah Residents</h3>
            <p>
              Residents of these states have similar rights under their respective state privacy laws, including the
              right to access, correct, delete, and obtain a portable copy of your data, as well as the right to opt
              out of certain data processing activities.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">International Users (GDPR)</h3>
            <p>
              If you are located in the European Economic Area or United Kingdom, you have rights under the General
              Data Protection Regulation (GDPR), including the right to access, rectify, erase, restrict processing,
              and port your data. You also have the right to lodge a complaint with your local data protection authority.
            </p>

            <p className="mt-4">
              To exercise any of these rights, email us at{' '}
              <a href="mailto:dev@roamready.ai" className="text-[#1F6F8B] hover:underline">dev@roamready.ai</a>.
              We will respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Data Retention</h2>
            <p>
              We retain your personal data for as long as your account is active. When you delete your account, we
              will delete or anonymize your personal data within 90 days, except where we are required to retain it
              for legal, tax, or regulatory purposes (such as billing records).
            </p>
            <p className="mt-3">
              Trip data and journal entries are deleted along with your account. If you export a PDF or share a trip
              link before deletion, those external copies are not under our control.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Children's Privacy</h2>
            <p>
              RoamReady is intended for users aged 13 and older. Users must be 18 or older to purchase a paid
              subscription. We do not knowingly collect personal information from children under 13. If you believe
              a child under 13 has provided us with personal information, please contact us at{' '}
              <a href="mailto:dev@roamready.ai" className="text-[#1F6F8B] hover:underline">dev@roamready.ai</a>{' '}
              and we will promptly delete it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">International Users</h2>
            <p>
              RoamReady is operated from the United States. If you access the service from outside the United States,
              your information will be transferred to and processed in the United States, where data protection laws
              may differ from those in your country. By using RoamReady, you consent to this transfer.
            </p>
            <p className="mt-3">
              We take reasonable steps to ensure that your data is treated securely and in accordance with this
              Privacy Policy, regardless of where it is processed.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we make material changes, we will update the
              "Last updated" date at the top of this page and, where appropriate, notify you by email or through an
              in-app notice. Your continued use of RoamReady after any changes constitutes your acceptance of the
              updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Contact Us</h2>
            <p>If you have questions, concerns, or requests regarding this Privacy Policy or your personal data, please contact us:</p>
            <div className="mt-3 space-y-1">
              <p><strong>Martini AI Media LLC (RoamReady)</strong></p>
              <p>Arizona</p>
              <p>Email: <a href="mailto:dev@roamready.ai" className="text-[#1F6F8B] hover:underline">dev@roamready.ai</a></p>
              <p>Website: <a href="https://roamready.ai" className="text-[#1F6F8B] hover:underline">roamready.ai</a></p>
            </div>
          </section>

        </div>

        <div className="mt-12 pt-8 border-t border-gray-100 text-center">
          <Link to="/" className="text-sm text-[#1F6F8B] hover:underline">← Back to RoamReady</Link>
          <p className="text-xs text-gray-400 mt-4">© 2026 Martini AI Media LLC. All rights reserved.</p>
        </div>
      </div>
    </div>
  )
}
