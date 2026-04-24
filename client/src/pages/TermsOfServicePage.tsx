import { Link } from 'react-router-dom'
import logoIcon from '../assets/logo-icon.png'

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-4xl mx-auto py-12 px-6">
        <div className="mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-6">
            <img src={logoIcon} alt="RoamReady" className="h-8 w-auto object-contain" />
            <span className="font-medium">
              <span style={{ color: '#1E3A8A' }}>Roam</span><span style={{ color: '#F7A829' }}>ready</span><span style={{ color: '#1E3A8A' }}>.ai</span>
            </span>
          </Link>
          <h1 className="text-3xl font-semibold text-gray-900">Terms of Service</h1>
          <p className="text-sm text-gray-500 mt-2">Last updated: April 19, 2026</p>
        </div>

        <div className="prose max-w-none text-gray-700 space-y-10">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Acceptance of Terms</h2>
            <p>
              These Terms of Service ("Terms") are a legally binding agreement between you and Martini AI Media LLC,
              doing business as <strong>RoamReady</strong> ("RoamReady," "we," "us," or "our"), governing your use of the
              RoamReady platform available at roamready.ai (the "Service").
            </p>
            <p className="mt-3">
              By creating an account or using the Service, you confirm that you have read, understood, and agree to
              these Terms. If you do not agree, you may not use the Service.
            </p>
            <p className="mt-3">
              You must be at least 13 years old to use RoamReady. You must be at least 18 years old (or the age of
              majority in your jurisdiction) to purchase a paid subscription.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Description of Service</h2>
            <p>
              RoamReady is a subscription-based software-as-a-service (SaaS) platform for AI-powered outdoor trip
              planning. The Service allows users to:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Create accounts and manage vehicle and traveler profiles</li>
              <li>Generate AI-assisted camping trip itineraries and campground recommendations</li>
              <li>Plan routes, view weather forecasts, and organize trip details</li>
              <li>Export trip summaries as PDF documents</li>
              <li>Maintain a trip journal with photos and notes</li>
            </ul>
            <p className="mt-3">
              We reserve the right to add, modify, or discontinue features of the Service at any time with reasonable
              notice.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Account Registration</h2>
            <p>
              You must create an account to access most features. You agree to provide accurate, complete, and
              up-to-date information during registration and to keep your account credentials secure. You are
              responsible for all activity that occurs under your account.
            </p>
            <p className="mt-3">
              You may not share your account with others, create accounts by automated means, or create accounts for
              the purpose of circumventing subscription limits or abusing free trials.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Subscription and Billing</h2>
            <p>RoamReady offers the following subscription plans:</p>

            <div className="mt-4 space-y-3">
              <div className="border border-gray-100 rounded-lg p-4" style={{ borderWidth: '0.5px' }}>
                <h3 className="font-semibold text-gray-900">Free</h3>
                <p className="text-sm mt-1">Limited access to core features at no charge.</p>
              </div>
              <div className="border border-gray-100 rounded-lg p-4" style={{ borderWidth: '0.5px' }}>
                <h3 className="font-semibold text-gray-900">Pro — $8.99/month or $69.99/year</h3>
                <p className="text-sm mt-1">Full access to trip planning, AI itinerary generation, PDF export, and more.</p>
              </div>
              <div className="border border-gray-100 rounded-lg p-4" style={{ borderWidth: '0.5px' }}>
                <h3 className="font-semibold text-gray-900">Pro+ — $12.99/month or $109.99/year</h3>
                <p className="text-sm mt-1">All Pro features plus advanced tools, priority support, and additional capabilities.</p>
              </div>
            </div>

            <p className="mt-4">
              All paid subscriptions automatically renew at the end of each billing period until you cancel. By
              subscribing, you authorize us to charge your payment method on a recurring basis. You can cancel at any
              time through your account settings — cancellation stops future charges but does not refund the current
              billing period.
            </p>
            <p className="mt-3">
              We use Stripe to process all payments. By subscribing, you also agree to Stripe's terms of service.
              We do not store your full credit card number.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Refund Policy</h2>
            <p>
              New subscribers are eligible for a <strong>7-day money-back guarantee</strong> on their first subscription
              payment. To request a refund, email{' '}
              <a href="mailto:dev@roamready.ai" className="text-[#1E3A8A] hover:underline">dev@roamready.ai</a>{' '}
              within 7 days of your initial payment. This guarantee applies to first-time subscribers only and may
              not be applied to subsequent renewals or to accounts that have previously received a refund.
            </p>
            <p className="mt-3">
              After 7 days, subscription payments are <strong>non-refundable</strong>. Cancelling your subscription
              will stop future billing but will not result in a refund for any portion of the current billing period.
              You will retain access to your paid plan until the end of the period you have paid for.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Acceptable Use</h2>
            <p>You agree to use RoamReady only for lawful purposes and in accordance with these Terms. You may not:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Scrape, crawl, or extract data from the Service using automated tools</li>
              <li>Abuse, overload, or attempt to disrupt the Service or its infrastructure</li>
              <li>Reverse-engineer, decompile, or attempt to extract the source code of the Service</li>
              <li>Resell, sublicense, or otherwise commercialize access to the Service</li>
              <li>Use the Service to generate content for competing products or services</li>
              <li>Impersonate other users or circumvent access controls</li>
              <li>Upload content that infringes third-party intellectual property rights</li>
              <li>Use the Service for any purpose that violates applicable law</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">AI-Generated Content Disclaimer</h2>
            <p>
              RoamReady uses artificial intelligence to generate trip itineraries, campground recommendations, route
              suggestions, and other travel content. <strong>All AI-generated content is advisory and informational only.</strong>
            </p>
            <p className="mt-3">
              Before relying on any AI-generated suggestion, you must independently verify:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Campground availability, reservation requirements, and current pricing</li>
              <li>Campground hookup types, amenities, and access restrictions</li>
              <li>Road conditions, vehicle clearance restrictions, and route safety</li>
              <li>Hours of operation, seasonal closures, and permit requirements</li>
              <li>Any other information that is safety-critical for your trip</li>
            </ul>
            <p className="mt-3">
              AI-generated content may be outdated, inaccurate, or inapplicable to your specific vehicle, group, or
              conditions. <strong>RoamReady is not liable for errors in AI-generated suggestions or for any consequences
              arising from reliance on such content.</strong>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Outdoor Activity Disclaimer</h2>
            <p>
              Outdoor travel, camping, and overlanding involve inherent risks, including but not limited to adverse
              weather, wildlife encounters, mechanical failure, remote locations, physical injury, and emergencies.
            </p>
            <p className="mt-3">
              <strong>You travel at your own risk.</strong> RoamReady provides planning information only. We are not a tour
              operator, guide service, travel agency, or safety advisor. Nothing in the Service constitutes a
              guarantee of safety, suitability of a location, or fitness of a route for your vehicle or group.
            </p>
            <p className="mt-3">
              Always exercise your own judgment, check current conditions from authoritative sources, carry
              appropriate safety equipment, and be prepared to change your plans based on real-world conditions.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Intellectual Property</h2>
            <p>
              The RoamReady platform, including its software, design, branding, AI models, and proprietary content,
              is owned by Martini AI Media LLC and protected by applicable intellectual property laws. You may not
              copy, reproduce, or create derivative works from any part of the Service without our express written
              permission.
            </p>
            <p className="mt-3">
              <strong>You own your trip data.</strong> The destinations, journal entries, photos, notes, and other content
              you create within RoamReady remain yours. By using the Service, you grant us a limited license to store
              and process your content solely to provide the Service to you. We do not claim ownership of your content.
            </p>
            <p className="mt-3">
              If you upload photos or other content to RoamReady, you represent that you have the rights to share
              that content and that it does not infringe any third-party intellectual property rights.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">DMCA and Copyright</h2>
            <p>
              RoamReady respects intellectual property rights. If you believe that content on our platform infringes
              your copyright, please send a notice to{' '}
              <a href="mailto:dev@roamready.ai" className="text-[#1E3A8A] hover:underline">dev@roamready.ai</a>{' '}
              with the following: a description of the copyrighted work, a description of the infringing material and
              its location on our platform, your contact information, a statement of good faith belief, and your
              signature (electronic or physical). We will respond to valid DMCA notices promptly.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Termination</h2>
            <p>
              You may close your account at any time from your account settings. We may suspend or terminate your
              account, without prior notice, if you violate these Terms, engage in fraudulent activity, abuse the
              Service, or if continued operation of your account poses a risk to others or to the platform.
            </p>
            <p className="mt-3">
              Upon termination, your right to use the Service ceases immediately. We will delete your data in
              accordance with our Privacy Policy. Provisions of these Terms that by their nature should survive
              termination (including disclaimers, limitation of liability, and governing law) will remain in effect.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Warranty Disclaimers</h2>
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR
              IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, ROAMREADY DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT
              LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
              NON-INFRINGEMENT.
            </p>
            <p className="mt-3">
              We do not warrant that the Service will be uninterrupted, error-free, or free of viruses or other
              harmful components. We do not warrant the accuracy, completeness, or reliability of any AI-generated
              content or third-party data provided through the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Limitation of Liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, ROAMREADY AND ITS OFFICERS, DIRECTORS, EMPLOYEES,
              AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
              DAMAGES, INCLUDING LOSS OF PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR USE OF (OR
              INABILITY TO USE) THE SERVICE.
            </p>
            <p className="mt-3">
              IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS
              OR THE SERVICE EXCEED THE GREATER OF (A) THE TOTAL AMOUNT YOU PAID TO ROAMREADY IN THE 12 MONTHS
              PRECEDING THE CLAIM, OR (B) $10 USD.
            </p>
            <p className="mt-3">
              Some jurisdictions do not allow the exclusion of certain warranties or the limitation of liability for
              certain damages. In such jurisdictions, our liability is limited to the greatest extent permitted by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Changes to Terms</h2>
            <p>
              We may update these Terms from time to time. When we make material changes, we will provide at least
              30 days' notice by updating the "Last updated" date at the top of this page and, where appropriate,
              notifying you by email or in-app notice.
            </p>
            <p className="mt-3">
              Your continued use of the Service after the notice period constitutes your acceptance of the updated
              Terms. If you do not agree to the revised Terms, you must stop using the Service and may close your
              account before the changes take effect.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Governing Law</h2>
            <p>
              These Terms are governed by and construed in accordance with the laws of the State of Arizona, without
              regard to its conflict of law provisions. Any disputes arising under these Terms shall be resolved
              exclusively in the state or federal courts located in Maricopa County, Arizona, and you consent to
              personal jurisdiction in those courts.
            </p>
            <p className="mt-3">
              If any provision of these Terms is found to be unenforceable, the remaining provisions will continue
              in full force and effect.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Contact Us</h2>
            <p>If you have questions about these Terms or the Service, please contact us:</p>
            <div className="mt-3 space-y-1">
              <p><strong>Martini AI Media LLC (RoamReady)</strong></p>
              <p>Arizona</p>
              <p>Email: <a href="mailto:dev@roamready.ai" className="text-[#1E3A8A] hover:underline">dev@roamready.ai</a></p>
              <p>Website: <a href="https://roamready.ai" className="text-[#1E3A8A] hover:underline">roamready.ai</a></p>
            </div>
          </section>

        </div>

        <div className="mt-12 pt-8 border-t border-gray-100 text-center">
          <Link to="/" className="text-sm text-[#1E3A8A] hover:underline">← Back to RoamReady</Link>
          <p className="text-xs text-gray-400 mt-4">© 2026 Martini AI Media LLC. All rights reserved.</p>
        </div>
      </div>
    </div>
  )
}
