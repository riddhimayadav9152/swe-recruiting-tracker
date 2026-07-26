import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.userProfile.upsert({
    where: { id: 'default-profile' },
    create: {
      id: 'default-profile',
      name: 'Riddhima Yadav',
      school: 'The University of Texas at Austin',
      major: 'Computer Science',
      graduation: 'December 2027',
      workAuthorization: 'U.S. citizen',
      preferredLocation: 'New York City',
      otherLocations: 'Major U.S. cities',
      currentExperience: 'DraftKings Software Engineering Intern',
      targetRoles: '2027 Software Engineering Internships',
      targetCategories: 'Highly selective technology, quantitative trading, fintech and strong product companies',
    },
    update: {},
  });

  const application = await prisma.application.upsert({
    where: { applicationCode: 'GOOG-SOFT-260726' },
    create: {
      applicationCode: 'GOOG-SOFT-260726',
      company: 'Google',
      role: 'Software Engineer Intern',
      priority: 'P1',
      status: 'Applied',
      currentStage: 'Application Submitted',
      applicationUrl: 'https://careers.google.com',
      location: 'New York, NY',
      notes: 'Strong fit for backend and product roles.',
      nextAction: 'Monitor application and email',
      nextActionDue: new Date(Date.now() + 10 * 86400000),
      dateFound: new Date(),
      dateApplied: new Date(),
      applicationDeadline: new Date(Date.now() + 5 * 86400000),
    },
    update: {},
  });

  await prisma.jobDescription.upsert({
    where: { applicationId: application.id },
    create: {
      applicationId: application.id,
      fullText: 'Software Engineer Intern role focused on backend systems and product delivery.',
      minimumQualifications: 'Computer Science major; data structures; algorithms',
      preferredQualifications: 'Internship experience; distributed systems',
      keywords: 'backend, systems, product',
    },
    update: {},
  });

  await prisma.resumeVersion.createMany({
    data: [
      {
        id: 'resume-generic',
        name: 'Generic SWE Resume',
        targetType: 'Full Stack',
        description: 'Core engineering resume',
        fileName: 'swe-generic.pdf',
      },
      {
        id: 'resume-company',
        name: 'Google Specific Resume',
        targetType: 'Company Specific',
        description: 'Tailored to Google',
        fileName: 'google-specific.pdf',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.activity.create({
    data: {
      applicationId: application.id,
      eventType: 'Opportunity created',
      summary: 'Seeded intro application for the tracker',
      metadataJson: JSON.stringify({ source: 'seed' }),
    },
  });
}

main().finally(() => prisma.$disconnect());
