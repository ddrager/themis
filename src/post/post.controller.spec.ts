import { Test, TestingModule } from '@nestjs/testing';
import { PostController } from './post.controller';
import { PostService } from './post.service';
import { Post } from './post.entity';
import * as uuidv4 from 'uuid/v4';
import { User } from '../user/user.entity';
import { CreatePostDto } from './create-post.dto';
import { CreateTopLevelPostDto } from './create-top-level-post.dto';
import { CreateReplyDto } from './create-reply.dto';

jest.mock('./post.service');

describe('Post Controller', () => {
  let module: TestingModule;
  let controller: PostController;
  let service: jest.Mocked<PostService>;
  
  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [PostController],
      providers: [PostService]
    }).compile();

    controller = module.get<PostController>(PostController);
    service = module.get<PostService>(PostService) as jest.Mocked<PostService>;
  });

  it('should be defined', () => {
    const controller: PostController = module.get<PostController>(PostController);
    expect(controller).toBeDefined();
  });

  it('successfully connects to service', async () => {
    expect(controller.findAll).toBeDefined();
    expect(await controller.findAll()).toBeUndefined();
  });

  describe('Method testing', () => {
    const data: Post[] = [
      {
        id: 1,
        uuid: uuidv4(),
        server: 'example.com',
        sender: new User,
        uri: '',
        parentUri: '',
        groups: [],
        subject: 'Subject',
        content: 'Body text',
        source: '',
        timestamp: '',
        deleted: false,
        children: [],
        parent: undefined
      },
      {
        id: 2,
        uuid: uuidv4(),
        server: 'example.com',
        sender: new User,
        uri: '',
        parentUri: '',
        groups: [],
        subject: '2nd Subject',
        content: 'Different text',
        source: '',
        timestamp: '',
        deleted: false,
        children: [],
        parent: undefined
      }
    ].map((p) => Object.assign(new Post, p));

  beforeAll(() => {
      service.findAll.mockImplementation(() => data);
      service.findByUuid.mockImplementation((u: string) => data.find((_) => _.uuid === u));
      service.create.mockImplementation((entity) => Object.assign(new Post, entity));
      service.createTopLevel.mockImplementation((entity) => Object.assign(new Post, entity));
      service.createReply.mockImplementation((entity) => Object.assign(new Post, entity));
      service.delete.mockImplementation((u: string) => data.find((_) => _.uuid === u));
    });

    it('findAll should return all posts', async () => {
      const result = await controller.findAll();

      expect(result).toBeDefined();
      expect(result.length).toBe(2);
      expect(result[0]).toBeInstanceOf(Post);
    });

    it('find by UUID should return the appropriate post', async () => {
      const uuid = data[1].uuid;
      const result = await controller.findByUuid(uuid);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Post);
      expect(result).toMatchObject(data[1]);
    });

    it('find by group should return only top-level posts in that group', async () => {
      
    });

    it('find by user should return all posts by a user', async () => {
      
    });

    it('find all by group should return all posts in a group', async () => {
      
    });

    it('create should return a new Post entity', async () => {
      const entity: CreatePostDto = {
        sender: 'user',
        server: 'example.com',
        subject: 'Subject',
        parent: '',
        primaryGroup: 'group',
        ccGroups: [],
        content: 'Body text',
        source: ''
      }
      const result = await controller.create(entity);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Post);
    });
    
    it('creating a top-level post should return a new Post entity', async () => {
      const entity : CreateTopLevelPostDto = {
        sender: 'user',
        server: 'example.com',
        subject: 'Subject',
        primaryGroup: 'group',
        ccGroups: [],
        content: 'Body text',
        source: ''
      }
      const result = await controller.createTopLevel(entity);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Post);
    });

    it('replyTo should return a new Post entity', async () => {
      const entity: CreateReplyDto = {
        sender: 'user',
        server: 'example.com',
        subject: 'Subject',
        group: 1,
        content: 'Body text',
        source: ''        
      }

      const result = await controller.replyTo(entity, data[0].uuid);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Post);
    });

    it('delete should return the deleted entity', async () => {
      const uuid = data[1].uuid;
      const result = await controller.delete(uuid);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Post);
    });
  });
});
