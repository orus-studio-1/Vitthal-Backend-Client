import type { PoolClient } from 'pg';
import pool from '../../DbConnect';

type ServiceCategorySeed = {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
};

const serviceCategorySeeds: ServiceCategorySeed[] = [
  {
    code: 'machine_maintenance',
    label: 'Machine Maintenance',
    description: 'Machine maintenance, repair, and service quotations.',
    sortOrder: 0,
  },
  {
    code: 'job_inquiry',
    label: 'Job Inquiry',
    description:
      'Submit multi-item jobwork inquiries with drawings, material specifications, and delivery requirements.',
    sortOrder: 1,
  },
  {
    code: 'logistics',
    label: 'Logistics',
    description:
      'Transport and delivery requests with pickup and drop-off details, load information, delivery timing, and vendor trip quotations.',
    sortOrder: 2,
  },
  {
    code: 'goods_ticket_inquiry',
    label: 'Goods Ticket Inquiry',
    description:
      'Submit a goods order with company location, mobile contact, delivery date, order image, and order placement details for vendor quotations.',
    sortOrder: 3,
  },
  {
    code: 'freelancer_work',
    label: 'Freelancer Work',
    description:
      'Freelance design, CAD, manufacturing, CNC, CAM, tooling, and quality advisory projects.',
    sortOrder: 4,
  },
];

async function seedServiceCategory(
  client: PoolClient,
  category: ServiceCategorySeed,
) {
  await client.query(
    `INSERT INTO public.service_categories
       (code, label, description, image, min_commision_percentage,
        max_commision_percentage, sort_order, is_active)
     VALUES ($1, $2, $3, '', 0, 10, $4, true)
     ON CONFLICT (code) DO UPDATE SET
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       is_active = true,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()`,
    [category.code, category.label, category.description, category.sortOrder],
  );
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const category of serviceCategorySeeds) {
      await seedServiceCategory(client, category);
      console.log(`Seeded service category: ${category.label}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Failed to seed service categories:', error);
    process.exitCode = 1;
  });
}

export { serviceCategorySeeds, seedServiceCategory };
