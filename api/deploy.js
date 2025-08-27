import { createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { GraphQLClient, gql } from 'graphql-request';
import { Octokit } from '@octokit/rest';

const prisma = new PrismaClient();
const railway = new GraphQLClient('https://backboard.railway.app/graphql/v2', {
  headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
});
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

async function triggerBuilderWorkflow(owner, repo, railwayServiceId) {
  console.log(`Attempting to dispatch workflow 'deployer.yml' for ${owner}/${repo}`);
  try {
    // First, let's try to get the workflow to make sure it exists
    const workflows = await octokit.rest.actions.listRepoWorkflows({
      owner: 'VarunGupta2005',
      repo: 'Deployer',
    });

    console.log('Available workflows:', workflows.data.workflows.map(w => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state,
      created_at: w.created_at,
      updated_at: w.updated_at
    })));

    const deployerWorkflow = workflows.data.workflows.find(w => w.path === '.github/workflows/deployer.yml');

    if (!deployerWorkflow) {
      throw new Error('Deployer workflow not found');
    }

    console.log('Using workflow:', deployerWorkflow);

    // Let's also check the workflow details
    const workflowDetails = await octokit.rest.actions.getWorkflow({
      owner: 'VarunGupta2005',
      repo: 'Deployer',
      workflow_id: deployerWorkflow.id,
    });

    console.log('Workflow details:', {
      id: workflowDetails.data.id,
      name: workflowDetails.data.name,
      path: workflowDetails.data.path,
      state: workflowDetails.data.state,
      created_at: workflowDetails.data.created_at,
      updated_at: workflowDetails.data.updated_at
    });

    await octokit.rest.actions.createWorkflowDispatch({
      owner: 'VarunGupta2005',
      repo: 'Deployer',
      workflow_id: deployerWorkflow.id,
      ref: 'main',
      inputs: {
        owner: owner,
        repo: repo,
        railwayServiceId: railwayServiceId,
      },
    });
    console.log("Successfully dispatched the workflow.");
  } catch (error) {
    console.error("Error dispatching workflow:", error.status, error.message);
    // Rethrow the error to be caught by the main handler
    throw error;
  }
}

export default async function handler(req, res) {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const payload = JSON.stringify(req.body);
    const hash = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    // Uncomment this block for production security
    // if (signature !== hash) {
    //   return res.status(401).json({ message: 'Invalid signature.' });
    // }

    const eventType = req.headers['x-github-event'];
    let repositoriesToProcess = [];

    if (eventType === 'push' && req.body.ref === 'refs/heads/main') {
      repositoriesToProcess.push(req.body.repository);
    } else if (eventType === 'installation_repositories' && req.body.action === 'added') {
      repositoriesToProcess = req.body.repositories_added;
    } else {
      return res.status(200).json({ message: 'Event ignored.' });
    }

    for (const repository of repositoriesToProcess) {
      const githubRepoId = BigInt(repository.id);
      const repoName = repository.full_name;
      const owner = repository.owner.login;
      const repo = repository.name;

      console.log(`Processing event for ${repoName}.`);
      let project = await prisma.project.findUnique({ where: { githubRepoId } });

      if (!project) {
        console.log(`First deployment for ${repoName}. Provisioning on Railway...`);

        const createProjectMutation = gql`mutation { projectCreate(input: { name: "${repoName}" }) { id } }`;
        const projectData = await railway.request(createProjectMutation);
        const railwayProjectId = projectData.projectCreate.id;

        const createServiceMutation = gql`
          mutation { serviceCreate(input: {
            name: "${repo}",
            projectId: "${railwayProjectId}",
            source: { image: "ghcr.io/railwayapp/nixpacks/node:latest" }
          }) { id } }
        `;
        const serviceData = await railway.request(createServiceMutation);
        const railwayServiceId = serviceData.serviceCreate.id;

        project = await prisma.project.create({
          data: { githubRepoId, repoName, railwayProjectId, railwayServiceId },
        });
        console.log(`Successfully provisioned Railway service ${railwayServiceId}.`);
      }

      console.log(`Triggering builder for service ${project.railwayServiceId}`);
      await triggerBuilderWorkflow(owner, repo, project.railwayServiceId);
    }

    res.status(202).json({ message: 'Deployment process initiated.' });

  } catch (error) {
    console.error('Error in webhook handler:', error.message);
    res.status(500).json({ message: 'An internal error occurred.' });
  }
}